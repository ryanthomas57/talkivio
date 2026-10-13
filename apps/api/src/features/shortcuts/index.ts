/**
 * Feature module registration for "shortcuts". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 *
 * Canned replies (ch. 18): scoped CRUD with versioning, allowlisted placeholder
 * rendering, RFC 4180 CSV import (preview → atomic commit) and export.
 */
import type { Provider, Type } from '@nestjs/common';
import { ShortcutsController } from './shortcuts.controller';
import { ShortcutsService } from './shortcuts.service';

export const SHORTCUTS_PROVIDERS: Provider[] = [ShortcutsService];
export const SHORTCUTS_CONTROLLERS: Type<unknown>[] = [ShortcutsController];
