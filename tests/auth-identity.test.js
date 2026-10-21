const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required to run the isolated auth tests.');

const testDatabaseName = `artube_auth_test_${process.pid}_${Date.now()}`;
const isolatedMongoUri = new URL(process.env.MONGODB_URI);
isolatedMongoUri.pathname = `/${testDatabaseName}`;
process.env.MONGODB_URI = isolatedMongoUri.toString();
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const app = require('../server');
const { User, Post, RadioChannel } = app.locals.models;
const suffix = crypto.randomBytes(6).toString('hex');
const ids = { users: [], posts: [] };
let httpServer;
let baseUrl;

const send = async (method, route, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
};

test.before(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([User.init(), Post.init(), RadioChannel.init(), app.locals.radioIndexesReady]);
  await new Promise((resolve) => {
    httpServer = app.listen(0, resolve);
  });
  const address = httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  try {
    if (ids.posts.length) await Post.deleteMany({ _id: { $in: ids.posts } });
    if (ids.users.length) {
      await RadioChannel.deleteMany({ ownerId: { $in: ids.users } });
      await User.deleteMany({ _id: { $in: ids.users } });
    }
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.disconnect();
  }
});

test('auth identity, username uniqueness, profile access, content ownership, radio ownership and logout', async (t) => {
  const ownerUsername = `${suffix}_owner`;
  const ownerEmail = `${suffix}+owner@example.test`;
  const ownerPassword = 'test-password-123';

  await t.test('signup returns a backend token and rejects invalid or taken usernames clearly', async () => {
    const invalid = await send('POST', '/api/auth/register', {
      body: { username: 'bad.name', email: `${suffix}+invalid@example.test`, password: ownerPassword },
    });
    assert.equal(invalid.status, 400);

    const signup = await send('POST', '/api/auth/register', {
      body: { username: ownerUsername, email: ownerEmail, password: ownerPassword, role: 'admin' },
    });
    assert.equal(signup.status, 201);
    assert.ok(signup.data.token);
    assert.equal(signup.data.user.role, 'user');
    assert.equal(signup.data.user.username, ownerUsername);
    ids.users.push(signup.data.user.id);
    t.mock.method(console, 'log', () => {});

    const taken = await send('POST', '/api/auth/register', {
      body: { username: ownerUsername.toUpperCase(), email: `${suffix}+duplicate@example.test`, password: ownerPassword },
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.code, 'USERNAME_TAKEN');
    assert.match(taken.data.error, /already in use/i);
    assert.equal(JSON.stringify(taken.data).includes('MongoServerError'), false);
    t.owner = signup.data;
  });

  await t.test('simultaneous signups cannot claim the same normalized username', async () => {
    const sharedUsername = `${suffix}_race`;
    const [first, second] = await Promise.all([
      send('POST', '/api/auth/register', {
        body: { username: sharedUsername, email: `${suffix}+race1@example.test`, password: ownerPassword },
      }),
      send('POST', '/api/auth/register', {
        body: { username: `@${sharedUsername.toUpperCase()}`, email: `${suffix}+race2@example.test`, password: ownerPassword },
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const winner = first.status === 201 ? first : second;
    assert.equal(winner.data.user.username, sharedUsername);
    ids.users.push(winner.data.user.id);
    t.other = winner.data;
  });

  await t.test('profile changes retain immutable identity and existing account relationships', async () => {
    const owner = t.owner;
    const other = t.other;
    const ownerId = String(owner.user.id);
    const originalEmail = owner.user.email;

    const sharedProfileHandle = `${suffix}_profile_race`;
    const [ownerClaim, otherClaim] = await Promise.all([
      send('PUT', `/api/users/${ownerId}`, { token: owner.token, body: { username: sharedProfileHandle } }),
      send('PUT', `/api/users/${other.user.id}`, { token: other.token, body: { username: sharedProfileHandle } }),
    ]);
    assert.deepEqual([ownerClaim.status, otherClaim.status].sort(), [200, 409]);
    if (ownerClaim.status === 200) owner.user.username = sharedProfileHandle;
    else other.user.username = sharedProfileHandle;

    const createdPost = await send('POST', '/api/posts', {
      token: owner.token,
      body: {
        title: `${suffix} artwork`,
        tag: 'auth-test',
        visibility: 'public',
        userId: other.user.id,
        userEmail: other.user.email,
        author: 'Impersonated Author',
      },
    });
    assert.equal(createdPost.status, 201);
    assert.equal(String(createdPost.data.userId), ownerId);
    assert.equal(createdPost.data.userEmail, originalEmail);
    assert.equal(createdPost.data.author, owner.user.username);
    ids.posts.push(createdPost.data._id);

    const commentWithoutAuth = await send('POST', `/api/posts/${createdPost.data._id}/comment`, {
      body: { text: 'anonymous comment', userId: other.user.id, author: 'Spoofed' },
    });
    assert.equal(commentWithoutAuth.status, 401);

    const comment = await send('POST', `/api/posts/${createdPost.data._id}/comment`, {
      token: owner.token,
      body: { text: 'comment tied to account', userId: other.user.id, author: 'Spoofed' },
    });
    assert.equal(comment.status, 201);
    assert.equal(String(comment.data.comments[0].userId), ownerId);
    assert.equal(comment.data.comments[0].author, owner.user.username);

    const likeWithoutAuth = await send('POST', `/api/posts/${createdPost.data._id}/like`, { body: { userId: ownerId } });
    assert.equal(likeWithoutAuth.status, 401);
    const like = await send('POST', `/api/posts/${createdPost.data._id}/like`, {
      token: owner.token,
      body: { userId: other.user.id },
    });
    assert.equal(like.status, 200);
    const likedOwner = await User.findById(ownerId);
    assert.ok(likedOwner.likedPosts.some((postId) => String(postId) === String(createdPost.data._id)));

    const follow = await send('POST', `/api/users/${other.user.id}/follow`, {
      token: owner.token,
      body: { followerId: other.user.id, creatorName: other.user.username },
    });
    assert.equal(follow.status, 200);
    const followedUser = await User.findById(other.user.id);
    assert.ok(followedUser.followers.some((followerId) => String(followerId) === ownerId));

    const privatePost = await send('POST', '/api/posts', {
      token: owner.token,
      body: { title: `${suffix} draft`, tag: 'auth-test', visibility: 'private' },
    });
    assert.equal(privatePost.status, 201);
    ids.posts.push(privatePost.data._id);
    assert.equal((await send('GET', `/api/posts?userId=${ownerId}&visibility=private`)).status, 401);
    assert.equal((await send('GET', `/api/posts?userId=${ownerId}&visibility=private`, { token: other.token })).status, 403);
    const ownerDrafts = await send('GET', `/api/posts?userId=${ownerId}&visibility=private`, { token: owner.token });
    assert.equal(ownerDrafts.status, 200);
    assert.ok(ownerDrafts.data.some((post) => String(post._id) === String(privatePost.data._id)));

    const renamedUsername = `${suffix}_renamed`;
    const update = await send('PUT', `/api/users/${ownerId}`, {
      token: owner.token,
      body: {
        username: renamedUsername,
        displayName: 'Stable Display Name',
        email: 'attacker@example.test',
        firebaseUid: 'attacker-firebase-uid',
      },
    });
    assert.equal(update.status, 200);
    assert.equal(String(update.data._id), ownerId);
    assert.equal(update.data.username, renamedUsername);
    assert.equal(update.data.email, originalEmail);
    assert.equal(update.data.firebaseUid, undefined);

    const me = await send('GET', '/api/auth/me', { token: owner.token });
    assert.equal(me.status, 200);
    assert.equal(String(me.data._id), ownerId);
    assert.equal(me.data.email, originalEmail);
    assert.equal(me.data.username, renamedUsername);

    const ownAvailability = await send('GET', `/api/auth/username-availability?username=${renamedUsername}`, { token: owner.token });
    assert.equal(ownAvailability.status, 200);
    assert.equal(ownAvailability.data.available, true);
    const takenAvailability = await send('GET', `/api/auth/username-availability?username=${other.user.username}`);
    assert.equal(takenAvailability.data.available, false);

    const duplicateUpdate = await send('PUT', `/api/users/${ownerId}`, {
      token: owner.token,
      body: { username: other.user.username },
    });
    assert.equal(duplicateUpdate.status, 409);
    assert.match(duplicateUpdate.data.error, /already in use/i);
    const unchanged = await User.findById(ownerId);
    assert.equal(unchanged.username, renamedUsername);
    assert.equal(unchanged.email, originalEmail);

    const publicProfile = await send('GET', `/api/users/profile/${renamedUsername}`);
    assert.equal(publicProfile.status, 200);
    assert.equal(String(publicProfile.data._id), ownerId);
    assert.equal(publicProfile.data.email, undefined);
    assert.equal(publicProfile.data.firebaseUid, undefined);

    const postsAfterRename = await send('GET', `/api/users/${ownerId}/posts`, { token: owner.token });
    assert.equal(postsAfterRename.status, 200);
    assert.ok(postsAfterRename.data.some((post) => String(post._id) === String(createdPost.data._id)));
    assert.equal(String(postsAfterRename.data.find((post) => String(post._id) === String(createdPost.data._id)).comments[0].userId), ownerId);
    assert.equal(String((await User.findById(other.user.id)).followers[0]), ownerId);

    const wrongOwnerEdit = await send('PUT', `/api/posts/${createdPost.data._id}`, {
      token: other.token,
      body: { title: 'stolen post', userId: other.user.id },
    });
    assert.equal(wrongOwnerEdit.status, 403);

    const usernameLogin = await send('POST', '/api/auth/login', {
      body: { emailOrUsername: renamedUsername, password: ownerPassword },
    });
    assert.equal(usernameLogin.status, 200);
    assert.equal(String(usernameLogin.data.user.id), ownerId);
    const emailLogin = await send('POST', '/api/auth/login', {
      body: { emailOrUsername: originalEmail, password: ownerPassword },
    });
    assert.equal(emailLogin.status, 200);
    assert.equal(String(emailLogin.data.user.id), ownerId);
    t.ownerAfterRename = { ...usernameLogin.data, user: update.data };
  });

  await t.test('Firebase-linked profile updates preserve Firebase UID and ID; unverified sync is closed', async () => {
    const firebaseUid = `firebase-test-${suffix}`;
    const firebaseUser = await User.create({
      username: `${suffix}_firebase`,
      email: `${suffix}+firebase@example.test`,
      firebaseUid,
      displayName: 'Firebase Test User',
    });
    ids.users.push(firebaseUser._id);
    const firebaseToken = app.locals.createUserSessionToken(firebaseUser);
    const changedUsername = `${suffix}_firebase2`;
    const update = await send('PUT', `/api/users/${firebaseUser._id}`, {
      token: firebaseToken,
      body: { username: changedUsername, email: 'attacker@example.test', firebaseUid: 'attacker-uid' },
    });
    assert.equal(update.status, 200);
    assert.equal(String(update.data._id), String(firebaseUser._id));
    assert.equal(update.data.email, firebaseUser.email);
    assert.equal(update.data.firebaseUid, firebaseUid);

    if (!app.locals.firebaseAdminConfigured) {
      const bodyOnlySync = await send('POST', '/api/users/firebase-sync', {
        body: { firebaseUid: `unverified-${suffix}`, email: `${suffix}+fake@example.test`, username: `${suffix}_fake` },
      });
      assert.equal(bodyOnlySync.status, 503);
      assert.equal(bodyOnlySync.data.code, 'FIREBASE_AUTH_UNAVAILABLE');
    }
  });

  await t.test('radio frequency stays with the MongoDB ID, and tokens expire or revoke safely', async () => {
    const ownerId = String(t.owner.user.id);
    const token = t.ownerAfterRename.token;
    const activation = await send('POST', '/api/radio/activate', { token, body: {} });
    assert.equal(activation.status, 200);
    const assignedFrequency = activation.data.frequency;

    const afterRename = await send('GET', '/api/radio/me', { token });
    assert.equal(afterRename.status, 200);
    assert.equal(afterRename.data.frequency, assignedFrequency);
    assert.equal(String(afterRename.data.channel.ownerId), ownerId);

    const wrongOwnerStart = await send('POST', `/api/radio/channels/${assignedFrequency}/start`, {
      token: t.other.token,
      body: {},
    });
    assert.equal(wrongOwnerStart.status, 403);
    const ownerStart = await send('POST', `/api/radio/channels/${assignedFrequency}/start`, { token, body: {} });
    assert.equal(ownerStart.status, 503);
    assert.equal(ownerStart.data.code, 'AUDIO_TRANSPORT_UNAVAILABLE');

    const invalid = await send('GET', '/api/auth/me', { token: 'not-a-jwt' });
    assert.equal(invalid.status, 401);
    const expiredToken = jwt.sign({ sub: ownerId, id: ownerId, ver: 0, exp: Math.floor(Date.now() / 1000) - 1 }, process.env.JWT_SECRET);
    const expired = await send('GET', '/api/auth/me', { token: expiredToken });
    assert.equal(expired.status, 401);

    const logout = await send('POST', '/api/auth/logout', { token, body: {} });
    assert.equal(logout.status, 200);
    const afterLogout = await send('GET', '/api/auth/me', { token });
    assert.equal(afterLogout.status, 401);
  });
});
