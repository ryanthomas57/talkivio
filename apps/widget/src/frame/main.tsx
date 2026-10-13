/**
 * Widget iframe entry. Served by the API at /widget/frame/:publicId under a strict CSP
 * (no inline scripts, no eval). `?preview=1` renders the dashboard live preview instead
 * of connecting a socket.
 */
import { render } from 'preact';
import { Controller } from './controller';
import { App } from './ui/app';
import './styles.css';

declare const __WIDGET_VERSION__: string;

const data = document.body.dataset;
const widgetId = data.siteKey || data.widgetId || decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const api = (data.api || location.origin).replace(/\/+$/, '');
const preview = data.preview === '1' || new URLSearchParams(location.search).get('preview') === '1';

const controller = new Controller(widgetId, api, preview, __WIDGET_VERSION__);
const mount = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
render(<App c={controller} />, mount);
controller.start();
