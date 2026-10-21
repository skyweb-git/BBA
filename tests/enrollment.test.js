const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const app = require('../server');
const { User, Course } = app.locals.models;

test('Course Enrollment API Suite', async (t) => {
  await mongoose.connection.asPromise();

  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const username = `student_${Date.now()}`;
  let user;
  let course;
  let token;

  await t.test('1. Setup user, course, and auth token', async () => {
    user = await User.create({
      username,
      email: `${username}@test.com`,
      displayName: 'Art Enthusiast',
      profileSetupCompleted: true,
    });
    token = app.locals.createUserSessionToken(user);
    assert.ok(token, 'Token should be generated');

    course = await Course.create({
      title: 'Landscape Art & Lighting',
      author: 'Master Elena',
      enrolledCount: 0,
      enrolled: '0 enrolled',
    });
    assert.ok(course._id, 'Course should be created');
  });

  await t.test('2. Enrolling in course increments count and updates user enrolledCourses', async () => {
    const res = await fetch(`${baseUrl}/api/courses/${course._id}/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const updatedUser = await User.findById(user._id);
    assert.ok(
      updatedUser.enrolledCourses.some((id) => String(id) === String(course._id)),
      'User should have course in enrolledCourses'
    );

    const updatedCourse = await Course.findById(course._id);
    assert.equal(updatedCourse.enrolledCount, 1);
  });

  await t.test('3. Duplicate enroll does not double-increment count', async () => {
    const res = await fetch(`${baseUrl}/api/courses/${course._id}/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(res.status, 200);
    const updatedCourse = await Course.findById(course._id);
    assert.equal(updatedCourse.enrolledCount, 1);
  });

  await t.test('4. GET /api/users/me/enrolled-courses returns enrolled courses', async () => {
    const res = await fetch(`${baseUrl}/api/users/me/enrolled-courses`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.some((c) => String(c._id) === String(course._id)));
  });

  // Cleanup
  await User.findByIdAndDelete(user._id);
  await Course.findByIdAndDelete(course._id);
  server.close();
});
