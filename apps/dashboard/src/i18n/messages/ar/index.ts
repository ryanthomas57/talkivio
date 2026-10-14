import type { MessageKey } from '../en';
import { common } from './common';
import { format } from './format';
import { shell } from './shell';
import { ui } from './ui';
import { inbox } from './inbox';
import { auth } from './auth';
import { pages } from './pages';
import { notifications } from './notifications';
import { settings } from './settings';
import { sites } from './sites';
import { customFields } from './customFields';
import { bans } from './bans';
import { offline } from './offline';
import { triggers } from './triggers';
import { integrations } from './integrations';
import { privacy } from './privacy';
import { audit } from './audit';
import { shortcuts } from './shortcuts';
import { visitors } from './visitors';
import { team } from './team';
import { analytics } from './analytics';
import { history } from './history';
import { monitor } from './monitor';
import { dock } from './dock';
import { billing } from './billing';

export const ar: Record<MessageKey, string> = {
  ...common,
  ...format,
  ...shell,
  ...ui,
  ...inbox,
  ...auth,
  ...pages,
  ...notifications,
  ...settings,
  ...sites,
  ...customFields,
  ...bans,
  ...offline,
  ...triggers,
  ...integrations,
  ...privacy,
  ...audit,
  ...shortcuts,
  ...visitors,
  ...team,
  ...analytics,
  ...history,
  ...monitor,
  ...dock,
  ...billing,
};
export const AREAS = {
  common,
  format,
  shell,
  ui,
  inbox,
  auth,
  pages,
  notifications,
  settings,
  sites,
  customFields,
  bans,
  offline,
  triggers,
  integrations,
  privacy,
  audit,
  shortcuts,
  visitors,
  team,
  analytics,
  history,
  monitor,
};
