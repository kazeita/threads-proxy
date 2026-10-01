// Vercel Function entry. vercel.json rewrites every path here (original path in ?__p=).
import { handle } from '../src/handler.js';

const run = (request) => handle(request, { ip: request.headers.get('x-real-ip') || undefined });

export const GET = run;
export const HEAD = run;
export const OPTIONS = run;
