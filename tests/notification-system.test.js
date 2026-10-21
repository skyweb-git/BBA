const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required to run the notification tests.');

const testDatabaseName = `artube_notif_test_${process.pid}_${Date.now()}`;
const isolatedMongoUri = new URL(process.env.MONGODB_URI);
isolatedMongoUri.pathname = `/${testDatabaseName}`;
process.env.MONGODB_URI = isolatedMongoUri.toString();
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const app = require('../server');
const { User, Post, RadioChannel, Course, Notification } = app.locals.models;
const suffix = crypto.randomBytes(6).toString('hex');
const ids = { users: [], posts: [], courses: [], channels: [], notifications: [] };
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
  await Promise.all([
    User.init(),
    Post.init(),
    RadioChannel.init(),
    Course.init(),
    Notification.init(),
    app.locals.radioIndexesReady,
  ]);
  await new Promise((resolve) => {
    httpServer = app.listen(0, resolve);
  });
  const address = httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  try {
    if (ids.posts.length) await Post.deleteMany({ _id: { $in: ids.posts } });
    if (ids.courses.length) await Course.deleteMany({ _id: { $in: ids.courses } });
    if (ids.channels.length) await RadioChannel.deleteMany({ _id: { $in: ids.channels } });
    if (ids.users.length) await User.deleteMany({ _id: { $in: ids.users } });
    await Notification.deleteMany({ userId: { $in: ids.users } });
  } finally {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }
});

test('Artube Notification System - Complete Verification Suite', async (t) => {
  // Create test accounts: userA (Follower), userB (Public Artist), userC (Private Artist)
  const userA = await User.create({
    username: `${suffix}_usera`,
    email: `${suffix}_usera@example.test`,
    displayName: 'User Alpha',
    isPrivate: false,
  });
  ids.users.push(userA._id);
  const tokenA = app.locals.createUserSessionToken(userA);

  const userB = await User.create({
    username: `${suffix}_userb`,
    email: `${suffix}_userb@example.test`,
    displayName: 'Artist Bravo',
    isPrivate: false,
    radioFrequency: '108.9',
    radioEnabled: true,
  });
  ids.users.push(userB._id);
  const tokenB = app.locals.createUserSessionToken(userB);

  const userC = await User.create({
    username: `${suffix}_userc`,
    email: `${suffix}_userc@example.test`,
    displayName: 'Creator Charlie',
    isPrivate: true,
  });
  ids.users.push(userC._id);
  const tokenC = app.locals.createUserSessionToken(userC);

  // 1. FOLLOW NOTIFICATIONS
  await t.test('A. Follow notifications: generates notification for followed artist, no self-notif', async () => {
    // UserA follows UserB (public)
    const followRes = await send('POST', `/api/users/${userB._id}/follow`, { token: tokenA });
    assert.equal(followRes.status, 200);
    assert.equal(followRes.data.isFollowing, true);

    // Verify UserB received the follow notification
    const notifB = await send('GET', '/api/notifications', { token: tokenB });
    assert.equal(notifB.status, 200);
    assert.ok(Array.isArray(notifB.data.notifications));
    const followNotif = notifB.data.notifications.find((n) => n.type === 'follow' && String(n.actorId) === String(userA._id));
    assert.ok(followNotif, 'Follow notification should exist for UserB');
    assert.equal(followNotif.user, 'User Alpha');
    assert.ok(followNotif.action.includes('following you'));
    assert.equal(followNotif.unread, true);

    // Verify UserA did NOT get a notification about following B
    const notifA = await send('GET', '/api/notifications', { token: tokenA });
    const selfNotif = (notifA.data.notifications || []).find((n) => String(n.userId) === String(userA._id) && n.type === 'follow');
    assert.equal(selfNotif, undefined, 'UserA should not receive a notification for their own action');
  });

  await t.test('A2. Follow duplicate prevention and unfollow rules', async () => {
    // Unfollow UserB
    const unfollowRes = await send('POST', `/api/users/${userB._id}/follow`, { token: tokenA });
    assert.equal(unfollowRes.status, 200);
    assert.equal(unfollowRes.data.isFollowing, false);

    // Count notifications on B - unfollow should NOT create any notification
    const countBefore = await Notification.countDocuments({ userId: userB._id });
    
    // Follow UserB again
    await send('POST', `/api/users/${userB._id}/follow`, { token: tokenA });
    const countAfter = await Notification.countDocuments({ userId: userB._id, type: 'follow' });
    // Within throttle window, duplicate spam is prevented
    assert.equal(countAfter, 1, 'Duplicate follow notification within throttle window should be prevented');
  });

  // 2. CONNECTION REQUEST & ACCEPTANCE
  await t.test('B. Connection request & acceptance for private accounts', async () => {
    // UserA follows UserC (private account) -> creates connection request
    const reqRes = await send('POST', `/api/users/${userC._id}/follow`, { token: tokenA });
    assert.equal(reqRes.status, 200);
    assert.equal(reqRes.data.isRequested, true);

    // UserC should receive a connection_request notification
    const notifC = await send('GET', '/api/notifications', { token: tokenC });
    assert.equal(notifC.status, 200);
    const connReqNotif = notifC.data.notifications.find((n) => n.type === 'connection_request');
    assert.ok(connReqNotif, 'UserC should have connection_request notification');
    assert.equal(String(connReqNotif.requesterId), String(userA._id));

    // UserC accepts connection request
    const acceptRes = await send('POST', `/api/users/requests/${userA._id}/accept`, { token: tokenC });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.data.success, true);

    // UserA should receive a connection_accepted notification
    const notifA = await send('GET', '/api/notifications', { token: tokenA });
    const acceptedNotif = notifA.data.notifications.find((n) => n.type === 'connection_accepted');
    assert.ok(acceptedNotif, 'UserA should have connection_accepted notification');
    assert.equal(String(acceptedNotif.actorId), String(userC._id));
  });

  // 3. CONNECTED ARTIST CONTENT NOTIFICATIONS
  await t.test('C. Content upload notifications: Watch video, artwork, and Learn course', async () => {
    // UserB uploads a video post (UserA is following UserB)
    const postVideo = await send('POST', '/api/posts', {
      token: tokenB,
      body: {
        title: 'Painting Masters Tutorial',
        mediaType: 'video',
        mp4Url: 'https://example.test/video.mp4',
        visibility: 'public',
      },
    });
    assert.equal(postVideo.status, 201);
    ids.posts.push(postVideo.data._id);

    // UserB creates a course in Learn
    const course = await send('POST', '/api/courses', {
      token: tokenB,
      body: {
        title: 'Oil Painting 101',
        level: 'Beginner',
        visibility: 'public',
      },
    });
    assert.equal(course.status, 201);
    ids.courses.push(course.data._id);

    // UserA should receive new_video and new_course notifications
    const notifA = await send('GET', '/api/notifications', { token: tokenA });
    const videoNotif = notifA.data.notifications.find((n) => n.type === 'new_video');
    assert.ok(videoNotif, 'UserA should receive new_video notification');
    assert.equal(String(videoNotif.postId), String(postVideo.data._id));

    const courseNotif = notifA.data.notifications.find((n) => n.type === 'new_course');
    assert.ok(courseNotif, 'UserA should receive new_course notification');
    assert.equal(String(courseNotif.courseId), String(course.data._id));

    // UserB (the creator) must NOT have received notification for their own upload
    const notifB = await send('GET', '/api/notifications', { token: tokenB });
    const selfUploadNotif = notifB.data.notifications.find((n) => n.type === 'new_video' || n.type === 'new_course');
    assert.equal(selfUploadNotif, undefined, 'Creator must not receive notification for own uploads');
  });

  // 4. ARTWAVE RADIO NOTIFICATIONS
  await t.test('D. Artwave Radio live start notifications', async () => {
    // Create radio channel record for UserB
    const channel = await RadioChannel.create({
      frequency: '108.9',
      ownerId: userB._id,
      channelName: 'Bravo Live Radio',
      isLive: false,
    });
    ids.channels.push(channel._id);

    // UserB starts broadcast on their frequency
    const radioStart = await send('POST', '/api/radio/channels/108.9/start', { token: tokenB });
    assert.equal(radioStart.status, 200);

    // UserA (follower of B) should receive radio_live notification
    const notifA = await send('GET', '/api/notifications', { token: tokenA });
    const radioNotif = notifA.data.notifications.find((n) => n.type === 'radio_live');
    assert.ok(radioNotif, 'UserA should receive radio_live notification');
    assert.equal(radioNotif.channelFrequency, '108.9');

    // Clean up channel
    await send('POST', '/api/radio/channels/108.9/stop', { token: tokenB });
  });

  // 5. SECURITY & USER ISOLATION
  await t.test('E. Security: Users cannot access, modify, or delete others notifications', async () => {
    // Get a notification belonging to UserA
    const notifA = await send('GET', '/api/notifications', { token: tokenA });
    const targetNotif = notifA.data.notifications[0];
    assert.ok(targetNotif, 'Target notification should exist');

    // UserB tries to mark UserA notification as read
    const hackRead = await send('PATCH', `/api/notifications/${targetNotif._id}/read`, { token: tokenB });
    assert.equal(hackRead.status, 404, 'UserB must not be able to mark UserA notification as read');

    // UserB tries to delete UserA notification
    const hackDelete = await send('DELETE', `/api/notifications/${targetNotif._id}`, { token: tokenB });
    assert.equal(hackDelete.status, 404, 'UserB must not be able to delete UserA notification');
  });

  // 6. UNREAD COUNTS, MARK READ, AND MARK ALL READ
  await t.test('F. Unread count and mark read endpoints', async () => {
    const unreadRes = await send('GET', '/api/notifications/unread-count', { token: tokenA });
    assert.equal(unreadRes.status, 200);
    assert.ok(typeof unreadRes.data.count === 'number');
    const initialUnread = unreadRes.data.count;
    assert.ok(initialUnread > 0, 'UserA should have unread notifications');

    // Mark single notification as read
    const notifList = await send('GET', '/api/notifications', { token: tokenA });
    const firstNotif = notifList.data.notifications[0];
    const readRes = await send('PATCH', `/api/notifications/${firstNotif._id}/read`, { token: tokenA });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.data.success, true);
    assert.equal(readRes.data.notification.unread, false);
    assert.equal(readRes.data.notification.isRead, true);

    // Mark all as read
    const readAllRes = await send('PATCH', '/api/notifications/read-all', { token: tokenA });
    assert.equal(readAllRes.status, 200);
    assert.equal(readAllRes.data.success, true);

    const finalUnread = await send('GET', '/api/notifications/unread-count', { token: tokenA });
    assert.equal(finalUnread.data.count, 0, 'Unread count should be 0 after mark-all-read');
  });

  // 7. PAGINATION AND BULK CLEAR
  await t.test('G. Pagination and clear all user notifications', async () => {
    // Pagination test
    const page1 = await send('GET', '/api/notifications?page=1&limit=2', { token: tokenA });
    assert.equal(page1.status, 200);
    assert.equal(page1.data.page, 1);
    assert.equal(page1.data.limit, 2);
    assert.ok(page1.data.notifications.length <= 2);
    assert.ok(page1.data.total >= 2);

    // Clear all for UserA
    const clearRes = await send('DELETE', '/api/notifications', { token: tokenA });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.data.success, true);

    const checkA = await send('GET', '/api/notifications', { token: tokenA });
    assert.equal(checkA.data.notifications.length, 0, 'UserA notifications should be empty after clear');

    // UserB and UserC notifications must remain intact
    const checkC = await send('GET', '/api/notifications', { token: tokenC });
    assert.ok(checkC.data.notifications.length > 0, 'UserC notifications must not be affected by UserA clear');
  });
});
