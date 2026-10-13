/**
 * Local-only test identities for dashboard end-to-end checks against a development
 * database (never production). Accounts are created through the public signup flow.
 */
export const UI_OWNER = {
  workspace: 'UI Test Workspace',
  name: 'Uma Owner',
  email: 'ui-owner@talkivio.test',
  password: 'talkivio-ui-test-pass-01',
} as const;
