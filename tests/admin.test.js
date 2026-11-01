const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// We use the running or imported app
test('Artube Admin Portal & API Tests', async (t) => {
  const app = require('../server.js');
  let server;
  let baseUrl;
  let adminToken;
  let testPostId;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  await t.test('1. Admin UI static files exist and serve index.html with root element', async () => {
    const adminDistPath = path.resolve(__dirname, '../../../../admin/dist/index.html');
    assert.equal(fs.existsSync(adminDistPath), true, 'admin/dist/index.html must exist');

    const res = await fetch(`${baseUrl}/admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes('<div id="root"></div>'), true);
  });

  await t.test('2. Admin login endpoint authenticates and returns JWT token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailOrUsername: 'admin@artube.com',
        password: 'admin123',
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(Boolean(data.token), true);
    assert.equal(data.user.role, 'admin');
    adminToken = data.token;
  });

  await t.test('3. Admin stats endpoint returns metrics', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(typeof stats.totalPosts, 'number');
    assert.equal(typeof stats.totalCourses, 'number');
    assert.equal(typeof stats.totalUsers, 'number');
  });

  await t.test('4. Admin can create a new post with custom text, bold formatting, and thumbnail', async () => {
    const postPayload = {
      title: 'Ethereal Landscapes Deluxe',
      isBold: true,
      titleWeight: '700',
      author: 'Studio Artist',
      category: 'explore',
      thumbnailUrl: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=600',
      description: 'A brand new bold artwork card',
      visibility: 'public',
    };

    const res = await fetch(`${baseUrl}/api/admin/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(postPayload),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.title, 'Ethereal Landscapes Deluxe');
    assert.equal(created.isBold, true);
    assert.equal(created.titleWeight, '700');
    testPostId = created._id;
  });

  await t.test('5. Admin can update post: change text, toggle bold, and update thumbnail', async () => {
    assert.equal(Boolean(testPostId), true);

    const updatePayload = {
      title: 'Majestic Mountains (Updated)',
      isBold: false,
      titleWeight: '600',
      thumbnailUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=600',
    };

    const res = await fetch(`${baseUrl}/api/admin/posts/${testPostId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(updatePayload),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.title, 'Majestic Mountains (Updated)');
    assert.equal(updated.isBold, false);
    assert.equal(updated.titleWeight, '600');
    assert.equal(updated.thumbnailUrl.includes('506744038136'), true);
  });

  await t.test('6. Admin can delete a post', async () => {
    assert.equal(Boolean(testPostId), true);

    const res = await fetch(`${baseUrl}/api/admin/posts/${testPostId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  });

  await t.test('7. App branding endpoint returns logo configuration', async () => {
    const res = await fetch(`${baseUrl}/api/app-config`);
    assert.equal(res.status, 200);
    const config = await res.json();
    assert.equal(typeof config.logoType, 'string');
    assert.equal(Boolean(config.logoPrefix), true);
  });

  await t.test('8. Admin can customize logo text colors and switch to image logo', async () => {
    // 8a. Update text logo
    const textLogoRes = await fetch(`${baseUrl}/api/admin/app-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        logoType: 'text',
        logoPrefix: 'SuperArt',
        logoSuffix: 'Tube',
        logoPrefixColor: '#FF0000',
        logoSuffixColor: '#000000',
      }),
    });
    assert.equal(textLogoRes.status, 200);
    const textConfig = await textLogoRes.json();
    assert.equal(textConfig.logoType, 'text');
    assert.equal(textConfig.logoPrefix, 'SuperArt');
    assert.equal(textConfig.logoSuffix, 'Tube');
    assert.equal(textConfig.logoPrefixColor, '#FF0000');

    // 8b. Switch to custom image logo
    const imageLogoRes = await fetch(`${baseUrl}/api/admin/app-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        logoType: 'image',
        logoImageUrl: 'https://artube.artartist.in/assets/custom-logo.png',
      }),
    });
    assert.equal(imageLogoRes.status, 200);
    const imageConfig = await imageLogoRes.json();
    assert.equal(imageConfig.logoType, 'image');
    assert.equal(imageConfig.logoImageUrl, 'https://artube.artartist.in/assets/custom-logo.png');

    // 8c. Reset back to clean default Artube text
    await fetch(`${baseUrl}/api/admin/app-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        logoType: 'text',
        logoPrefix: 'Art',
        logoSuffix: 'ube',
        logoPrefixColor: '#B31E1B',
        logoSuffixColor: '#101828',
        logoImageUrl: '',
      }),
    });
  });

  server.close();
  setTimeout(() => process.exit(0), 100);
});
