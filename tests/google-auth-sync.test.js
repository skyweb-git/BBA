const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required to run the tests.');

const testDatabaseName = `artube_auth_test_${process.pid}_${Date.now()}`;
const isolatedMongoUri = new URL(process.env.MONGODB_URI);
isolatedMongoUri.pathname = `/${testDatabaseName}`;
process.env.MONGODB_URI = isolatedMongoUri.toString();
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-long-session-secret-artube-2026-production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a-very-long-jwt-secret-artube-2026-production';

const mongoose = require('mongoose');
const app = require('../server');
const { User } = app.locals.models;

let httpServer;
let baseUrl;

const send = async (method, route, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
};

test.before(async () => {
  await new Promise((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.connection.dropDatabase();
    } catch (_) {}
    await mongoose.disconnect();
  }
});

test('Google Auth Sync & Profile Completion Suite', async (t) => {
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const testGoogleEmail = `googleuser_${uniqueId}@gmail.com`;
  const testFirebaseUid = `fb_uid_${uniqueId}`;

  await t.test('1. First-time Google Sync creates new user with isNewUser: true and profileSetupCompleted: false', async () => {
    const devToken = jwt.sign(
      { uid: testFirebaseUid, user_id: testFirebaseUid, email: testGoogleEmail, email_verified: true },
      process.env.JWT_SECRET
    );

    const { status, data } = await send('POST', '/api/users/firebase-sync', {
      token: devToken,
      body: {
        firebaseUid: testFirebaseUid,
        email: testGoogleEmail,
        displayName: 'Google Dev User',
        avatarUrl: 'https://lh3.googleusercontent.com/test-photo.jpg'
      }
    });

    assert.equal(status, 201, `Expected HTTP 201, got ${status}`);
    assert.equal(data.isNewUser, true, 'First-time sync must return isNewUser: true');
    assert.equal(data.profileSetupCompleted, false, 'New user profile must not be marked complete initially');
    assert.ok(data.user, 'Must return user object');
    assert.ok(data.token, 'Must return session token');
    assert.equal(data.user.email, testGoogleEmail);
  });

  await t.test('2. Routine Google Sign-In before profile completion returns isNewUser: false and profileSetupCompleted: false', async () => {
    const devToken = jwt.sign(
      { uid: testFirebaseUid, user_id: testFirebaseUid, email: testGoogleEmail, email_verified: true },
      process.env.JWT_SECRET
    );

    const { status, data } = await send('POST', '/api/users/firebase-sync', {
      token: devToken,
      body: {
        firebaseUid: testFirebaseUid,
        email: testGoogleEmail,
        displayName: 'Google Dev User',
        avatarUrl: 'https://lh3.googleusercontent.com/test-photo.jpg'
      }
    });

    assert.equal(status, 200, `Expected HTTP 200, got ${status}`);
    assert.equal(data.isNewUser, false, 'Subsequent login must be isNewUser: false');
    assert.equal(data.profileSetupCompleted, false, 'Profile setup still incomplete');
  });

  await t.test('3. Completing Step 2 Profile Setup updates handle, bio, and marks profileSetupCompleted: true', async () => {
    const customHandle = `artube_${uniqueId}`;
    const devToken = jwt.sign(
      { uid: testFirebaseUid, user_id: testFirebaseUid, email: testGoogleEmail, email_verified: true },
      process.env.JWT_SECRET
    );

    const { status, data } = await send('POST', '/api/users/firebase-sync', {
      token: devToken,
      body: {
        firebaseUid: testFirebaseUid,
        email: testGoogleEmail,
        displayName: 'Artube Verified Creator',
        username: customHandle,
        about: 'Passionate 3D digital sculptor and animator.',
        avatarUrl: 'https://artube.app/custom-avatar.jpg',
        profileSetupCompleted: true,
      }
    });

    assert.equal(status, 200, `Expected HTTP 200, got ${status}`);
    assert.equal(data.profileSetupCompleted, true, 'Profile must now be marked complete');
    assert.equal(data.user.username, customHandle, 'Username must be updated to user choice');
    assert.equal(data.user.displayName, 'Artube Verified Creator');
    assert.equal(data.user.about, 'Passionate 3D digital sculptor and animator.');
  });

  await t.test('4. Subsequent Google Sign-In preserves customized display name, avatar, bio, and returns profileSetupCompleted: true', async () => {
    const devToken = jwt.sign(
      { uid: testFirebaseUid, user_id: testFirebaseUid, email: testGoogleEmail, email_verified: true },
      process.env.JWT_SECRET
    );

    // Google sends default values again
    const { status, data } = await send('POST', '/api/users/firebase-sync', {
      token: devToken,
      body: {
        firebaseUid: testFirebaseUid,
        email: testGoogleEmail,
        displayName: 'Google Default Name',
        avatarUrl: 'https://lh3.googleusercontent.com/default-google.jpg'
      }
    });

    assert.equal(status, 200, `Expected HTTP 200, got ${status}`);
    assert.equal(data.isNewUser, false);
    assert.equal(data.profileSetupCompleted, true);
    // Crucial check: Custom display name, avatar and bio must NOT be overwritten by Google defaults!
    assert.equal(data.user.displayName, 'Artube Verified Creator', 'Custom display name must be preserved');
    assert.equal(data.user.avatarUrl, 'https://artube.app/custom-avatar.jpg', 'Custom avatar must be preserved');
    assert.equal(data.user.about, 'Passionate 3D digital sculptor and animator.', 'Bio must be preserved');
  });
});
