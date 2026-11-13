import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { forms } from './routes/forms';
import { menu } from './routes/menu';
import { scheduler_ } from './routes/scheduler';
import { triggers } from './routes/triggers';

const app = new Hono();
const internal = new Hono();

internal.route('/forms', forms);
internal.route('/menu', menu);
internal.route('/scheduler', scheduler_);
internal.route('/triggers', triggers);

app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
