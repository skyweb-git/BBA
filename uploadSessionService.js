'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.3gp', '.flv', '.m4v', '.mpeg', '.mpg', '.ts', '.wmv',
]);
const ALLOWED_PURPOSES = new Set(['post', 'course', 'course-lesson', 'avatar', 'cover']);

class UploadValidationError extends Error {
  constructor(message, status = 400, code = 'invalid_upload') {
    super(message);
    this.name = 'UploadValidationError';
    this.status = status;
    this.code = code;
  }
}

function normalizeUploadDescriptor(body = {}, expectedMediaType) {
  const mediaType = String(expectedMediaType || body.mediaType || '').trim().toLowerCase();
  const purpose = String(body.purpose || '').trim().toLowerCase();
  const originalName = path.basename(String(body.originalName || '').replace(/\\/g, '/')).trim();
  const mimeType = String(body.mimeType || '').split(';')[0].trim().toLowerCase();
  const sizeBytes = Number(body.sizeBytes);
  const title = String(body.title || originalName).trim().slice(0, 240);

  if (!['image', 'video'].includes(mediaType)) {
    throw new UploadValidationError('mediaType must be image or video.');
  }
  if (!ALLOWED_PURPOSES.has(purpose)) {
    throw new UploadValidationError('Unsupported upload purpose.');
  }
  if (!originalName || originalName.length > 240 || originalName === '.' || originalName === '..') {
    throw new UploadValidationError('A valid file name is required.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new UploadValidationError('sizeBytes must be a positive integer.');
  }

  const extension = path.extname(originalName).toLowerCase();
  if (mediaType === 'image') {
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      throw new UploadValidationError('Unsupported image format.');
    }
    if (extension && !new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']).has(extension)) {
      throw new UploadValidationError('Unsupported image file extension.');
    }
    if (sizeBytes > MAX_IMAGE_UPLOAD_BYTES) {
      throw new UploadValidationError('Images can be up to 10 MB.', 413, 'file_too_large');
    }
    if (purpose === 'avatar' || purpose === 'cover' || purpose === 'post' || purpose === 'course' || purpose === 'course-lesson') {
      return { mediaType, purpose, originalName, mimeType, sizeBytes, title };
    }
  }

  if (mediaType === 'video') {
    if (!mimeType.startsWith('video/')) {
      throw new UploadValidationError('The selected file must be a video.');
    }
    if (extension && !VIDEO_EXTENSIONS.has(extension)) {
      throw new UploadValidationError('Unsupported video file extension.');
    }
    if (!['post', 'course', 'course-lesson'].includes(purpose)) {
      throw new UploadValidationError('Videos are not allowed for this upload purpose.');
    }
    if (sizeBytes > MAX_VIDEO_UPLOAD_BYTES) {
      throw new UploadValidationError('Videos can be up to 500 MB.', 413, 'file_too_large');
    }
    return { mediaType, purpose, originalName, mimeType, sizeBytes, title };
  }

  throw new UploadValidationError('Unsupported upload.');
}

function validateIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new UploadValidationError('A valid Idempotency-Key header is required.');
  }
  return key;
}

function hashUploadDescriptor(descriptor) {
  const canonical = JSON.stringify({
    mediaType: descriptor.mediaType,
    purpose: descriptor.purpose,
    originalName: descriptor.originalName,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    title: descriptor.title,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function createBunnyTusAuthorization({ libraryId, apiKey, expiresAt, videoId }) {
  if (!libraryId || !apiKey || !videoId || !Number.isSafeInteger(Number(expiresAt))) {
    throw new TypeError('Bunny TUS authorization requires library, API key, expiry, and video ID.');
  }
  const expiry = String(expiresAt);
  const signature = crypto
    .createHash('sha256')
    .update(`${libraryId}${apiKey}${expiry}${videoId}`)
    .digest('hex');

  return {
    endpoint: 'https://video.bunnycdn.com/tusupload',
    headers: {
      AuthorizationSignature: signature,
      AuthorizationExpire: expiry,
      LibraryId: String(libraryId),
      VideoId: String(videoId),
    },
  };
}

function createCloudinaryUploadTicket({ cloudinary, cloudName, apiKey, apiSecret, session, folder = 'artube/uploads', now = Date.now() }) {
  if (!cloudinary?.utils?.api_sign_request || !cloudName || !apiKey || !apiSecret || !session?._id) {
    throw new TypeError('Cloudinary signed upload configuration is incomplete.');
  }
  const timestamp = Math.floor(now / 1000);
  const safeFolder = String(folder || 'artube/uploads')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9_/-]/g, '');
  const publicId = `${safeFolder}/asset_${session._id}`;
  const signedParams = {
    timestamp,
    public_id: publicId,
    context: `upload_session_id=${session._id}`,
    overwrite: false,
  };
  const signature = cloudinary.utils.api_sign_request(signedParams, apiSecret);

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    fields: {
      ...signedParams,
      api_key: apiKey,
      signature,
    },
    publicId,
    expiresAt: new Date((timestamp + 3600) * 1000),
  };
}

async function findOrCreateIdempotentSession({ UploadSession, userId, idempotencyKey, descriptor, expiresAt, provider }) {
  const requestHash = hashUploadDescriptor(descriptor);
  const filter = { userId, idempotencyKey };
  let existing = await UploadSession.findOne(filter);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new UploadValidationError('This Idempotency-Key was already used for different upload data.', 409, 'idempotency_conflict');
    }
    return { session: existing, created: false };
  }

  try {
    const session = await UploadSession.create({
      ...descriptor,
      userId,
      provider,
      idempotencyKey,
      requestHash,
      status: 'pending',
      expiresAt,
    });
    return { session, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    existing = await UploadSession.findOne(filter);
    if (!existing) throw error;
    if (existing.requestHash !== requestHash) {
      throw new UploadValidationError('This Idempotency-Key was already used for different upload data.', 409, 'idempotency_conflict');
    }
    return { session: existing, created: false };
  }
}

function toPublicUploadSession(session) {
  return {
    uploadId: String(session._id),
    provider: session.provider,
    mediaType: session.mediaType,
    purpose: session.purpose,
    status: session.status,
    originalName: session.originalName,
    sizeBytes: session.sizeBytes,
    expiresAt: session.expiresAt,
    providerAssetId: session.status === 'ready' ? session.providerAssetId : undefined,
    providerMetadata: session.status === 'ready' ? session.providerMetadata : undefined,
  };
}

module.exports = {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  IMAGE_FORMATS,
  UploadValidationError,
  normalizeUploadDescriptor,
  validateIdempotencyKey,
  hashUploadDescriptor,
  createBunnyTusAuthorization,
  createCloudinaryUploadTicket,
  findOrCreateIdempotentSession,
  toPublicUploadSession,
};
