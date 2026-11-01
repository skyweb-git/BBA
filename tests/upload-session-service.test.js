'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  UploadValidationError,
  normalizeUploadDescriptor,
  validateIdempotencyKey,
  createBunnyTusAuthorization,
  createCloudinaryUploadTicket,
  findOrCreateIdempotentSession,
} = require('../uploadSessionService');

test('validates media type, declared size, and purpose before issuing authorization', () => {
  assert.throws(() => normalizeUploadDescriptor({
    purpose: 'post', originalName: 'image.jpg', mimeType: 'image/jpeg', sizeBytes: 10_485_761,
  }, 'image'), (error) => error instanceof UploadValidationError && error.status === 413);
  assert.throws(() => normalizeUploadDescriptor({
    purpose: 'avatar', originalName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 20,
  }, 'video'), UploadValidationError);
  assert.equal(normalizeUploadDescriptor({
    purpose: 'post', originalName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 1024,
  }, 'video').mediaType, 'video');
});

test('requires a bounded idempotency key', () => {
  assert.equal(validateIdempotencyKey('upload:12345678'), 'upload:12345678');
  assert.throws(() => validateIdempotencyKey('short'), UploadValidationError);
  assert.throws(() => validateIdempotencyKey('invalid key 123'), UploadValidationError);
});

test('creates Bunny TUS headers with the documented SHA-256 input order', () => {
  const input = { libraryId: '123', apiKey: 'secret-test-key', expiresAt: 1790000000, videoId: 'guid-1' };
  const result = createBunnyTusAuthorization(input);
  const expected = crypto.createHash('sha256').update('123secret-test-key1790000000guid-1').digest('hex');
  assert.equal(result.endpoint, 'https://video.bunnycdn.com/tusupload');
  assert.equal(result.headers.AuthorizationSignature, expected);
  assert.equal(result.headers.VideoId, 'guid-1');
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test('signs only fixed Cloudinary fields and never returns the API secret', () => {
  let signed;
  const ticket = createCloudinaryUploadTicket({
    cloudinary: { utils: { api_sign_request: (params, secret) => { signed = { params, secret }; return 'signature'; } } },
    cloudName: 'demo', apiKey: 'public-key', apiSecret: 'secret-test', folder: '/artube/uploads/',
    session: { _id: 'session-1' }, now: 1_790_000_000_000,
  });
  assert.equal(ticket.uploadUrl, 'https://api.cloudinary.com/v1_1/demo/image/upload');
  assert.equal(ticket.publicId, 'artube/uploads/asset_session-1');
  assert.equal(signed.secret, 'secret-test');
  assert.equal(signed.params.timestamp, 1790000000);
  assert.equal('file' in signed.params, false);
  assert.equal(JSON.stringify(ticket).includes('secret-test'), false);
  assert.equal(ticket.fields.api_key, 'public-key');
});

test('creates an idempotent upload session once and returns the same session on retry', async () => {
  const rows = new Map();
  let creates = 0;
  const UploadSession = {
    findOne: async (filter) => rows.get(`${filter.userId}:${filter.idempotencyKey}`) || null,
    create: async (value) => {
      creates += 1;
      const row = { ...value, _id: 'session-1' };
      rows.set(`${value.userId}:${value.idempotencyKey}`, row);
      return row;
    },
  };
  const args = {
    UploadSession, userId: 'user-1', idempotencyKey: 'upload:12345678', provider: 'bunny',
    descriptor: normalizeUploadDescriptor({
      purpose: 'post', originalName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 1024,
    }, 'video'), expiresAt: new Date('2026-10-28T00:00:00Z'),
  };
  const first = await findOrCreateIdempotentSession(args);
  const second = await findOrCreateIdempotentSession(args);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.session._id, second.session._id);
  assert.equal(creates, 1);
  await assert.rejects(() => findOrCreateIdempotentSession({
    ...args, descriptor: { ...args.descriptor, title: 'different title' },
  }), (error) => error.status === 409);
});
