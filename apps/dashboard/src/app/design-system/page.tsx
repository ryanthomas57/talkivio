'use client';
/**
 * Component stories (ch. 05): every reusable control rendered live with its props,
 * keyboard behaviour, accessible name, an error example and responsive notes. This
 * page uses no tenant data and is also the target of the automated axe checks.
 */
import { Inbox, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { BrandLockup } from '@/components/brand';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  Combobox,
  ConfirmDialog,
  CountBadge,
  Dialog,
  DialogContent,
  DialogTrigger,
  DrawerContent,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  MultiCombobox,
  PanelError,
  PasswordInput,
  RadioGroup,
  Select,
  Skeleton,
  Spinner,
  StatusLabel,
  SwitchField,
  Table,
  TableScroll,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TD,
  Textarea,
  TH,
  THead,
  TimezonePicker,
  Tooltip,
  TR,
} from '@/components/ui';
import { MessageBubble, PendingBubble } from '@/components/inbox/message-bubble';
import type { Message } from '@/lib/types';

interface StoryProps {
  id: string;
  title: string;
  props: string;
  keyboard: string;
  a11y: string;
  responsive?: string;
  children: ReactNode;
}

function Story({ id, title, props, keyboard, a11y, responsive, children }: StoryProps) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader title={title} />
      <CardBody className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start gap-4">{children}</div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
          <dt className="font-medium text-fg-2">Props</dt>
          <dd className="font-mono text-xs leading-5 text-fg break-anywhere">{props}</dd>
          <dt className="font-medium text-fg-2">Keyboard</dt>
          <dd className="text-fg">{keyboard}</dd>
          <dt className="font-medium text-fg-2">Accessible name</dt>
          <dd className="text-fg">{a11y}</dd>
          {responsive && (
            <>
              <dt className="font-medium text-fg-2">Responsive</dt>
              <dd className="text-fg">{responsive}</dd>
            </>
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

const sample = (over: Partial<Message>): Message => ({
  id: over.id ?? 'm',
  chatId: 'c',
  seq: 1,
  clientMessageId: null,
  sender: { type: 'visitor', id: 'v', displayName: 'Visitor 2041' },
  automated: false,
  visibility: 'public',
  type: 'text',
  body: 'Hello',
  options: [],
  systemEvent: null,
  attachments: [],
  sentAt: new Date().toISOString(),
  redacted: false,
  ...over,
});

const STORIES = [
  ['button', 'Button'],
  ['field', 'Field, Input, Textarea, PasswordInput'],
  ['select', 'Select, Combobox, MultiCombobox, TimezonePicker'],
  ['choice', 'Checkbox, Switch, RadioGroup'],
  ['status', 'Badge, CountBadge, Avatar, StatusLabel'],
  ['tabs', 'Tabs'],
  ['menu', 'Menu and Tooltip'],
  ['overlay', 'Dialog, Drawer, ConfirmDialog'],
  ['feedback', 'Banner, EmptyState, PanelError, Skeleton, Spinner'],
  ['table', 'Table'],
  ['messages', 'Message bubbles'],
] as const;

/** Sample controls in the gallery respond, so nothing on the page looks broken; they never change any data. */
const exampleOnly = () => toast.info('Example only — controls in this gallery don’t change anything.');

export default function DesignSystemPage() {
  const [email, setEmail] = useState('not-an-email');
  const [tz, setTz] = useState('Europe/London');
  const [one, setOne] = useState<string | null>('sales');
  const [many, setMany] = useState<string[]>(['vip']);
  const [radio, setRadio] = useState<'broadcast' | 'assigned'>('broadcast');
  const [confirm, setConfirm] = useState(false);
  const deptOptions = [
    { value: 'sales', label: 'Sales' },
    { value: 'support', label: 'Support', hint: '3 waiting' },
    { value: 'billing', label: 'Billing', disabled: true },
  ];

  return (
    <main id="main" className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface px-4 py-4 lg:px-6">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3">
          <BrandLockup />
          <p className="text-sm text-fg-2">Component stories · tokens per ch. 05</p>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1280px] gap-6 p-4 lg:grid-cols-[220px_1fr] lg:p-6">
        <nav aria-label="Components" className="lg:sticky lg:top-6 lg:self-start">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {STORIES.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="inline-flex min-h-9 items-center rounded-md px-2.5 text-sm text-fg-2 hover:bg-surface-3 hover:text-fg"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-6">
          <h1 className="text-xl">Design system</h1>

          <Story
            id="button"
            title="Button"
            props="variant: primary | secondary | ghost | danger | danger-ghost | link · size: sm (32) | md (40) | lg (44) | icon | icon-sm · loading · asChild · native button attributes"
            keyboard="Tab to focus; Enter/Space activates. Disabled and loading buttons are skipped by activation but stay announced."
            a11y="Visible text, or aria-label for icon-only buttons."
            responsive="Touch targets ≥ 44 px on mobile: use size lg or wrap icon buttons in a 44 px row."
          >
            <Button onClick={exampleOnly} variant="primary">
              Save changes
            </Button>
            <Button onClick={exampleOnly}>Cancel</Button>
            <Button onClick={exampleOnly} variant="ghost">
              Skip
            </Button>
            <Button onClick={exampleOnly} variant="danger">
              <Trash2 className="size-4" aria-hidden /> Delete site
            </Button>
            <Button onClick={exampleOnly} variant="primary" loading>
              Publishing
            </Button>
            <Button disabled data-demo="">
              Disabled
            </Button>
            <Button onClick={exampleOnly} variant="secondary" size="icon" aria-label="Add origin">
              <Plus className="size-4" />
            </Button>
          </Story>

          <Story
            id="field"
            title="Field, Input, Textarea, PasswordInput"
            props="Field: label, description, error, required, hideLabel, action · controls receive id / aria-invalid / aria-describedby from Field"
            keyboard="Standard text editing. PasswordInput has a separate Show/Hide toggle button (aria-pressed)."
            a11y="Programmatic <label for>; description and error are referenced by aria-describedby; error text has an icon and role=alert."
            responsive="Full width inside forms; 16 px text in the widget avoids mobile zoom."
          >
            <div className="grid w-full gap-4 sm:grid-cols-2">
              <Field label="Work email" description="We send verification links here." required>
                <Input type="email" placeholder="name@company.com" />
              </Field>
              <Field label="Email (error example)" error="Enter a valid email address" required>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password">
                <PasswordInput autoComplete="new-password" />
              </Field>
              <Field label="Read only">
                <Input value="rds_ExampleKey" readOnly />
              </Field>
              <Field label="Welcome message" className="sm:col-span-2">
                <Textarea defaultValue="Hi there! How can we help?" />
              </Field>
            </div>
          </Story>

          <Story
            id="select"
            title="Select, Combobox, MultiCombobox, TimezonePicker"
            props="Select: native <select> props, compact · Combobox: value, onChange, options[{value,label,hint,disabled}], placeholder, emptyText · MultiCombobox: values[] · TimezonePicker: IANA value"
            keyboard="Select: native. Combobox: Enter/Space/↓ opens, type to filter, ↑↓ moves, Enter selects, Esc closes and returns focus."
            a11y="Trigger has role=combobox with the Field label; list items are options."
            responsive="Popover width follows the trigger; collision padding keeps it on screen at 320 px."
          >
            <div className="grid w-full gap-4 sm:grid-cols-2">
              <Field label="Routing mode">
                <Select defaultValue="broadcast">
                  <option value="broadcast">Broadcast</option>
                  <option value="assigned">Assigned</option>
                </Select>
              </Field>
              <Field label="Department">
                <Combobox value={one} onChange={setOne} options={deptOptions} />
              </Field>
              <Field label="Tags">
                <MultiCombobox
                  values={many}
                  onChange={setMany}
                  options={[
                    { value: 'vip', label: 'VIP' },
                    { value: 'refund', label: 'Refund' },
                  ]}
                />
              </Field>
              <Field label="Timezone">
                <TimezonePicker value={tz} onChange={setTz} />
              </Field>
            </div>
          </Story>

          <Story
            id="choice"
            title="Checkbox, Switch, RadioGroup"
            props="CheckboxField / SwitchField: label, description, checked, onCheckedChange, disabled · RadioGroup: legend, name, value, onChange, options"
            keyboard="Space toggles checkbox/switch; arrow keys move between radios in a group."
            a11y="Each control has a visible <label>; radios sit in a fieldset with a legend; descriptions via aria-describedby."
            responsive="Rows are ≥ 44 px tall for touch."
          >
            <div className="flex w-full flex-col gap-2">
              <CheckboxField label="Trust this device for 30 days" defaultChecked />
              <SwitchField
                label="Read receipts"
                description="Visitors see when agents have read their messages."
                defaultChecked
              />
              <SwitchField
                label="Disabled switch"
                description="Explains why: requires the attachments add-on."
                disabled
              />
              <RadioGroup
                legend="How should new chats reach agents?"
                name="story-routing"
                value={radio}
                onChange={setRadio}
                options={[
                  {
                    value: 'broadcast',
                    label: 'Broadcast',
                    description: 'Every available agent sees the chat.',
                  },
                  { value: 'assigned', label: 'Assigned', description: 'Offered to one agent at a time.' },
                ]}
              />
            </div>
          </Story>

          <Story
            id="status"
            title="Badge, CountBadge, Avatar, StatusLabel"
            props="Badge: tone neutral|primary|success|warning|danger|info|note, icon · CountBadge: count, label (full count for assistive tech), tone · Avatar: name, src, color, size · StatusLabel: status"
            keyboard="Not focusable (informational)."
            a11y="Status always combines icon + text + colour; CountBadge exposes the full number in aria-label while showing 99+."
            responsive="Badges truncate long text with an ellipsis."
          >
            <Badge tone="success">Active</Badge>
            <Badge tone="warning">Waiting</Badge>
            <Badge tone="note">Private note</Badge>
            <CountBadge count={7} label="unread messages" />
            <CountBadge count={140} label="waiting chats" tone="danger" />
            <Avatar name="Uma Owner" />
            <Avatar name="Visitor 2041" color="#7C3AED" size="md" />
            <StatusLabel status="online" />
            <StatusLabel status="away" />
            <StatusLabel status="invisible" />
            <StatusLabel status="offline" />
          </Story>

          <Story
            id="tabs"
            title="Tabs"
            props="Tabs (value/onValueChange or defaultValue), TabsList, TabsTrigger, TabsContent"
            keyboard="← → move between tabs, Home/End jump, Tab moves into the panel."
            a11y="role=tablist / tab / tabpanel with aria-selected and aria-controls (Radix)."
            responsive="The tab list scrolls horizontally on narrow screens instead of wrapping."
          >
            <Tabs defaultValue="general" className="w-full">
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="agents">Agents</TabsTrigger>
                <TabsTrigger value="routing">Routing</TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="pt-3 text-sm">
                General settings panel.
              </TabsContent>
              <TabsContent value="agents" className="pt-3 text-sm">
                Agents panel.
              </TabsContent>
              <TabsContent value="routing" className="pt-3 text-sm">
                Routing panel.
              </TabsContent>
            </Tabs>
          </Story>

          <Story
            id="menu"
            title="Menu and Tooltip"
            props="Menu/MenuTrigger/MenuContent/MenuItem (icon, danger)/MenuRadioGroup/MenuLabel/MenuSeparator · Tooltip: content, side"
            keyboard="Menu: Enter/Space/↓ opens, ↑↓ Home End move, typeahead, Esc closes. Tooltip: shows on focus or hover after 500 ms; Esc hides."
            a11y="Menu items are menuitem/menuitemradio; tooltips are never the only label."
            responsive="Menus have 8 px collision padding and 36 px minimum item height."
          >
            <Menu>
              <MenuTrigger asChild>
                <Button>More actions</Button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>Chat</MenuLabel>
                <MenuItem onSelect={exampleOnly}>Invite an agent</MenuItem>
                <MenuItem onSelect={exampleOnly}>Mute sounds for this chat</MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={exampleOnly} danger>
                  Leave chat
                </MenuItem>
              </MenuContent>
            </Menu>
            <Tooltip content="Visible label stays on the button; this adds detail.">
              <Button onClick={exampleOnly} variant="ghost">
                Hover or focus me
              </Button>
            </Tooltip>
          </Story>

          <Story
            id="overlay"
            title="Dialog, Drawer, ConfirmDialog"
            props="Dialog (open/onOpenChange) + DialogContent: title, description, footer, size sm|md|lg|xl · DrawerContent: title, side left|right, width · ConfirmDialog: title, description, confirmLabel, danger, onConfirm (errors stay in the dialog)"
            keyboard="Focus is trapped inside; Esc closes (unless blocked for required decisions); focus returns to the opener."
            a11y="role=dialog with aria-labelledby (title) and aria-describedby (description)."
            responsive="Dialogs are max 100vw − 32 px; drawers cap at the viewport width on phones."
          >
            <Dialog>
              <DialogTrigger asChild>
                <Button>Open dialog</Button>
              </DialogTrigger>
              <DialogContent
                title="Transfer chat"
                description="The agent gets 30 seconds to accept."
                footer={
                  <Button onClick={exampleOnly} variant="primary">
                    Transfer
                  </Button>
                }
              >
                <p className="text-sm">Dialog body content.</p>
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <Button>Open drawer</Button>
              </DialogTrigger>
              <DrawerContent title="Visitor details">
                <p className="p-5 text-sm">Drawer content.</p>
              </DrawerContent>
            </Dialog>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Delete webhook
            </Button>
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title="Delete webhook endpoint?"
              description="https://example.com/hooks will stop receiving events immediately."
              confirmLabel="Delete endpoint"
              danger
              onConfirm={() => Promise.reject(new Error('Example failure'))}
            />
          </Story>

          <Story
            id="feedback"
            title="Banner, EmptyState, PanelError, Skeleton, Spinner"
            props="Banner: tone info|success|warning|danger, title, action, live · EmptyState: icon, title, description, action · PanelError: message, onRetry · Skeleton: className · Spinner: label"
            keyboard="Only embedded actions are focusable."
            a11y="Danger banners use role=alert (assertive); others role=status (polite). Spinner has an accessible label."
            responsive="Banners wrap; actions drop below text on narrow screens."
          >
            <div className="flex w-full flex-col gap-3">
              <Banner tone="info">Confirm your email to invite teammates.</Banner>
              <Banner tone="success">Settings saved.</Banner>
              <Banner tone="warning" title="Not connected">
                You will not receive new chats until the connection recovers.
              </Banner>
              <Banner
                tone="danger"
                action={
                  <Button onClick={exampleOnly} size="sm">
                    Reload
                  </Button>
                }
              >
                The chat changed while you were editing.
              </Banner>
              <EmptyState
                icon={<Inbox />}
                title="No one is waiting"
                description="New chats in your departments appear here as they arrive."
              />
              <PanelError message="Could not load chats." onRetry={() => undefined} />
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-4 w-48" />
                <Spinner />
              </div>
            </div>
          </Story>

          <Story
            id="table"
            title="Table"
            props="TableScroll, Table, THead, TR (interactive, selected), TH, TD"
            keyboard="Rows are not focusable; put links/buttons inside cells."
            a11y="Native table semantics with scope=col headers; selected rows use aria-selected."
            responsive="Wrap in TableScroll so wide tables scroll inside the card, never the page; prefer card lists below 640 px."
          >
            <TableScroll className="w-full">
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Role</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Chats</TH>
                  </TR>
                </THead>
                <tbody>
                  <TR>
                    <TD>Uma Owner</TD>
                    <TD>Owner</TD>
                    <TD>
                      <StatusLabel status="online" />
                    </TD>
                    <TD className="text-right tabular">2 / 3</TD>
                  </TR>
                  <TR selected>
                    <TD>Ari Agent</TD>
                    <TD>Agent</TD>
                    <TD>
                      <StatusLabel status="away" />
                    </TD>
                    <TD className="text-right tabular">1 / 2</TD>
                  </TR>
                </tbody>
              </Table>
            </TableScroll>
          </Story>

          <Story
            id="messages"
            title="Message bubbles"
            props="MessageBubble: m, own, grouped, readByVisitor, deliveredToVisitor · PendingBubble: p (sending | failed), onRetry, onDiscard"
            keyboard="Timestamps are focusable to reveal the absolute time; Retry / Copy text / Discard are buttons."
            a11y="Text renders as plain text with safe links; notes carry a “Private note” label, automated messages an “Automated” label."
            responsive="Bubbles cap at min(76 %, 680 px) and wrap long URLs."
          >
            <div className="flex w-full flex-col rounded-md bg-canvas p-4" data-demo="">
              <MessageBubble
                m={sample({ id: 'a', body: 'Hi, do you ship to Canada?' })}
                own={false}
                grouped={false}
                readByVisitor={false}
              />
              <MessageBubble
                m={sample({
                  id: 'b',
                  seq: 2,
                  sender: { type: 'agent', id: 'me', displayName: 'Uma Owner' },
                  body: 'Yes — see https://example.com/shipping',
                })}
                own
                grouped={false}
                readByVisitor={false}
                deliveredToVisitor
              />
              <MessageBubble
                m={sample({
                  id: 'c',
                  seq: 3,
                  sender: { type: 'agent', id: 'me', displayName: 'Uma Owner' },
                  visibility: 'internal',
                  body: 'VIP customer, offer free returns.',
                })}
                own
                grouped={false}
                readByVisitor={false}
              />
              <PendingBubble
                p={{
                  clientMessageId: 'x',
                  chatId: 'c',
                  body: 'Message that failed to send',
                  visibility: 'public',
                  attachmentIds: [],
                  replyId: null,
                  options: [],
                  status: 'failed',
                  error: 'Network unavailable',
                  errorCode: 'NETWORK',
                  createdAt: 0,
                }}
                onRetry={() => undefined}
                onDiscard={() => undefined}
              />
            </div>
          </Story>
        </div>
      </div>
    </main>
  );
}
