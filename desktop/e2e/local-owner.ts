/** The dashboard's local UI test owner (development database only; see apps/dashboard/e2e/fixtures.ts). */
import { UI_OWNER } from '../../apps/dashboard/e2e/fixtures';

export const UI_OWNER_EMAIL = UI_OWNER.email;
export const UI_OWNER_PASSWORD = (UI_OWNER as unknown as { password: string }).password;
