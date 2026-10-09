// Netlify Function (v2): the timesheet's fast read API at /api, plus /api/ingest for the
// Apps Script publisher. The logic lives in ../lib/fastapi.mjs so tests can run it directly
// against an in-memory store. The existing slow path (/api/proxy → Apps Script) is untouched.
import { getStore } from '@netlify/blobs';
import { handle } from '../lib/fastapi.mjs';

export default async (req) => handle(req, getStore({ name: 'timesheet', consistency: 'strong' }), {
  INGEST_SECRET: process.env.INGEST_SECRET,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
});

export const config = { path: ['/api', '/api/ingest'] };
