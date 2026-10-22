/**
 * The in-repo HTTP test agent must fail when an expectation fails, or every
 * route suite built on it would pass vacuously (ADR-245).
 */
import express from 'express';
import multer from 'multer';
import { describe, expect, it } from 'vitest';
import { httpAgent, stringifyQuery } from './httpAgent.ts';

function app() {
  const server = express();
  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));
  server.get('/json', (req, res) => {
    res.set('X-Thing', 'yes').json({ query: req.query, accept: req.headers.accept ?? null });
  });
  server.post('/echo', (req, res) => {
    res.status(201).json({ body: req.body, type: req.headers['content-type'] });
  });
  server.get('/text', (_req, res) => {
    res.type('text/plain').send('hello');
  });
  server.get('/binary', (_req, res) => {
    res.type('application/pdf').send(Buffer.from([1, 2, 3]));
  });
  server.get('/empty', (_req, res) => {
    res.status(204).end();
  });
  server.get('/redirect', (_req, res) => {
    res.redirect(302, '/json');
  });
  server.post('/upload', multer({ storage: multer.memoryStorage() }).single('file'), (req, res) => {
    res.json({
      fields: req.body,
      file: req.file && {
        name: req.file.originalname,
        type: req.file.mimetype,
        text: req.file.buffer.toString(),
      },
    });
  });
  return server;
}

describe('httpAgent', () => {
  it('parses JSON, exposes headers and passes matching expectations', async () => {
    const res = await httpAgent(app())
      .get('/json')
      .query({ a: 1, list: ['x', 'y'], empty: null })
      .expect(200)
      .expect('X-Thing', 'yes')
      .expect('Content-Type', /json/)
      .expect((response) => {
        expect(response.ok).toBe(true);
      });
    expect(res.body).toEqual({ query: { a: '1', list: ['x', 'y'], empty: '' }, accept: null });
    expect(res.type).toBe('application/json');
    expect(res.headers['x-thing']).toBe('yes');
  });

  it('rejects on a wrong status, body, header or checker', async () => {
    const api = httpAgent(app());
    await expect(api.get('/json').expect(404)).rejects.toThrow('expected 404 "Not Found", got 200 "OK"');
    await expect(api.get('/text').expect('bye')).rejects.toThrow(/response body/);
    await expect(api.get('/json').expect(200, { other: true })).rejects.toThrow(/response body/);
    await expect(api.get('/json').expect('X-Thing', 'no')).rejects.toThrow(/X-Thing/);
    await expect(api.get('/json').expect('X-Missing', 'no')).rejects.toThrow(/header field/);
    await expect(
      api.get('/json').expect(() => {
        throw new Error('checker failed');
      }),
    ).rejects.toThrow('checker failed');
  });

  it('defaults .send(object) to JSON and .send(string) to form encoding', async () => {
    const json = await httpAgent(app()).post('/echo').send({ a: 1 }).send({ b: 2 }).expect(201);
    expect(json.body).toEqual({ body: { a: 1, b: 2 }, type: 'application/json' });
    const form = await httpAgent(app()).post('/echo').send('a=1').send('b=2').expect(201);
    expect(form.body).toEqual({ body: { a: '1', b: '2' }, type: 'application/x-www-form-urlencoded' });
  });

  it('keeps text and binary bodies like superagent', async () => {
    const text = await httpAgent(app()).get('/text').expect(200, 'hello');
    expect(text.body).toEqual({});
    const binary = await httpAgent(app()).get('/binary').expect(200);
    expect(binary.body).toEqual(Buffer.from([1, 2, 3]));
    const empty = await httpAgent(app()).get('/empty').expect(204);
    expect(empty.body).toEqual({});
  });

  it('does not follow redirects', async () => {
    await httpAgent(app()).get('/redirect').expect(302).expect('Location', '/json');
  });

  it('sends multipart fields and files that multer reads', async () => {
    const res = await httpAgent(app())
      .post('/upload')
      .field('account_id', 7)
      .field('flag', true)
      .attach('file', Buffer.from('a,b'), { filename: 'x.csv', contentType: 'text/csv' })
      .expect(200);
    expect(res.body).toEqual({
      fields: { account_id: '7', flag: 'true' },
      file: { name: 'x.csv', type: 'text/csv', text: 'a,b' },
    });
  });

  it('encodes queries like qs with indices off and strict nulls', () => {
    expect(stringifyQuery({ a: 'x y', b: [1, 2], c: null, d: undefined, e: { f: '!' } })).toBe(
      'a=x%20y&b=1&b=2&c&e%5Bf%5D=%21',
    );
  });
});
