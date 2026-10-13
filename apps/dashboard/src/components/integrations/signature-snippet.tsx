'use client';
import { Card, CardBody, CardHeader } from '@/components/ui';
import { useT } from '@/i18n';
import { richT } from './rich';
import { CodeSample } from './secret-panel';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './webhook-shared';

/**
 * Receiver-side verification example (ch. 55): HMAC-SHA256 over
 * `timestamp + "." + raw_body`, constant-time compare against every `v1=` entry
 * (two entries during a rotation overlap), 5-minute timestamp window, dedupe on
 * the event id. Static documentation — it never contains a real secret.
 */
const NODE_SNIPPET = `// Node 18+ with Express. Verify against the RAW body, before any JSON parsing.
import crypto from 'node:crypto';
import express from 'express';

// During a secret rotation, list both secrets until the overlap ends.
const SECRETS = [process.env.TALKIVIO_WEBHOOK_SECRET, process.env.TALKIVIO_WEBHOOK_PREVIOUS_SECRET].filter(Boolean);
const TOLERANCE_SECONDS = 5 * 60;

function isValidSignature(rawBody, timestamp, signatureHeader) {
  if (!/^\\d+$/.test(timestamp ?? '')) return false;
  // Reject requests older (or newer) than 5 minutes to stop replays.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  // Header: "v1=<hex>" or, during a rotation overlap, "v1=<new>,v1=<previous>".
  const received = (signatureHeader ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => Buffer.from(part.slice(3), 'utf8'));
  return SECRETS.some((secret) => {
    const expected = Buffer.from(
      crypto.createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex'),
      'utf8',
    );
    return received.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(sig, expected));
  });
}

const seen = new Set(); // use a durable store (database/Redis) in production

const app = express();
app.post('/talkivio/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  const ok = isValidSignature(rawBody, req.get('X-Talkivio-Timestamp'), req.get('X-Talkivio-Signature'));
  if (!ok) return res.status(401).send('invalid signature');

  const event = JSON.parse(rawBody); // { id, type, version, occurred_at, tenant_id, data }
  // Delivery is at least once: the same event id can arrive more than once.
  if (seen.has(event.id)) return res.sendStatus(200);
  seen.add(event.id);

  // ...handle event.type here, then answer 2xx quickly (within 10 seconds).
  res.sendStatus(204);
});

app.listen(3000);
`;

const SIGNATURE_FORMULA = 'v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>';

export function SignatureSnippet() {
  const t = useT();
  return (
    <Card>
      <CardHeader
        title={t('integrations.signature.title')}
        description={richT(t, 'integrations.signature.description', {
          timestampHeader: (
            <code className="font-mono text-xs" dir="ltr">
              {TIMESTAMP_HEADER}
            </code>
          ),
          signatureHeader: (
            <code className="font-mono text-xs" dir="ltr">
              {`${SIGNATURE_HEADER}: ${SIGNATURE_FORMULA}`}
            </code>
          ),
          eventIdHeader: (
            <code className="font-mono text-xs" dir="ltr">
              {EVENT_ID_HEADER}
            </code>
          ),
        })}
      />
      <CardBody>
        <CodeSample code={NODE_SNIPPET} what={t('integrations.what.nodeExample')} />
      </CardBody>
    </Card>
  );
}
