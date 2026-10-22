require('dotenv').config();
try {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('Warning: Could not set custom DNS servers, SRV resolution might fail:', err);
}

// ==========================================
// Firebase Admin SDK (server-side token verification)
// Firebase ID tokens are accepted only by /api/users/firebase-sync.
// ==========================================
let firebaseAdmin = null;
try {
  const fs = require('fs');
  const path = require('path');
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'service-account.json');

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    firebaseAdmin = admin;
    console.log('[Firebase Admin] Initialized — Firebase ID token verification ENABLED.');
  } else if (fs.existsSync(saPath)) {
    const admin = require('firebase-admin');
    const serviceAccount = require(saPath);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    firebaseAdmin = admin;
    console.log('[Firebase Admin] Initialized from service account file — Firebase ID token verification ENABLED.');
  } else {
    console.warn('[Firebase Admin] Firebase Admin credentials not found. Firebase sign-in is running in development fallback mode.');
  }
} catch (adminErr) {
  console.error('[Firebase Admin] Initialization failed:', adminErr.message);
}

const JWT_SECRET = String(process.env.JWT_SECRET || '');
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');
if (JWT_SECRET.trim().length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters.');
}
if (SESSION_SECRET.trim().length < 32) {
  throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
}
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Server: SocketIOServer } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true },
  path: '/socket.io',
});
const PORT = process.env.PORT || 5000;

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ==========================================
// Bunny.net Stream Video Integration
// ==========================================
const getBunnyStreamConfig = ({ readOnly = false } = {}) => {
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = readOnly ? process.env.BUNNY_STREAM_READ_KEY : process.env.BUNNY_STREAM_API_KEY;
  const cdnHostname = process.env.BUNNY_STREAM_CDN_HOSTNAME;
  const missing = [
    !libraryId && 'BUNNY_STREAM_LIBRARY_ID',
    !apiKey && (readOnly ? 'BUNNY_STREAM_READ_KEY' : 'BUNNY_STREAM_API_KEY'),
    !cdnHostname && 'BUNNY_STREAM_CDN_HOSTNAME',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Bunny Stream is not configured. Set: ${missing.join(', ')}`);
  }
  return { libraryId, apiKey, cdnHostname };
};

const isVideoFile = (file) => {
  if (!file) return false;
  return (file.mimetype && file.mimetype.startsWith('video/')) ||
         /\.(mp4|webm|mov|avi|mkv|3gp|flv|m4v)$/i.test(file.originalname || '');
};

const uploadVideoToBunnyStream = async (file, title = '') => {
  const { libraryId, apiKey, cdnHostname } = getBunnyStreamConfig();

  console.log(`[Bunny Stream] Creating video in library ${libraryId}...`);
  const createRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
    method: 'POST',
    headers: {
      'AccessKey': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      title: title || file.originalname || 'Artube Video'
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error('[Bunny Stream] Video creation failed:', errText);
    throw new Error(`Failed to create video on Bunny Stream: ${createRes.status}`);
  }

  const videoMeta = await createRes.json();
  const guid = videoMeta.guid;
  console.log(`[Bunny Stream] Video created with GUID: ${guid}. Uploading file stream...`);

  const fileStream = fs.createReadStream(file.path);
  const uploadRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${guid}`, {
    method: 'PUT',
    headers: {
      'AccessKey': apiKey,
      'Content-Type': 'application/octet-stream'
    },
    body: fileStream,
    duplex: 'half'
  });

  // Delete temp local file
  fs.unlink(file.path, (err) => {
    if (err) console.warn('[Bunny Stream] Could not delete temp file:', err.message);
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('[Bunny Stream] Binary upload failed:', errText);
    throw new Error(`Failed to upload video binary to Bunny Stream: ${uploadRes.status}`);
  }

  console.log(`[Bunny Stream] Video ${guid} successfully uploaded to Bunny CDN!`);

  const hlsUrl = `https://${cdnHostname}/${guid}/playlist.m3u8`;
  const mp4Url = `https://${cdnHostname}/${guid}/play_720p.mp4`;
  const thumbnailUrl = `https://${cdnHostname}/${guid}/thumbnail.jpg`;
  const previewUrl = `https://${cdnHostname}/${guid}/preview.webp`;
  const embedUrl = `https://iframe.mediadelivery.net/embed/${libraryId}/${guid}`;

  return {
    guid,
    libraryId: Number(libraryId),
    hlsUrl,
    mp4Url,
    thumbnailUrl,
    previewUrl,
    embedUrl,
    mediaUrl: hlsUrl
  };
};

const deleteVideoFromBunnyStream = async (guid) => {
  if (!guid) return;
  try {
    const { libraryId, apiKey } = getBunnyStreamConfig();
    const res = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${guid}`, {
      method: 'DELETE',
      headers: {
        'AccessKey': apiKey,
        'Accept': 'application/json'
      }
    });
    if (res.ok) {
      console.log(`[Bunny Stream] Deleted video ${guid} from Bunny library`);
    }
  } catch (err) {
    console.warn(`[Bunny Stream] Failed to delete video ${guid}:`, err.message);
  }
};

// Helper function to upload file to Cloudinary
const uploadToCloudinary = async (file) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.log('Cloudinary credentials not set, using local storage.');
    return `/uploads/${file.filename}`;
  }
  try {
    const options = {
      folder: process.env.CLOUDINARY_FOLDER || 'artube',
      resource_type: 'auto'
    };
    const result = await cloudinary.uploader.upload(file.path, options);
    // Delete local temp file
    fs.unlink(file.path, (err) => {
      if (err) console.error('Error deleting temp local file:', err);
    });
    return result.secure_url;
  } catch (err) {
    console.error('Cloudinary upload error, falling back to local file:', err);
    return `/uploads/${file.filename}`;
  }
};

// Helper function to upload base64 image data to Cloudinary or local storage
const uploadBase64ToStorage = async (base64Str, prefix = 'img') => {
  if (!base64Str || typeof base64Str !== 'string' || base64Str.trim() === '') return '';
  const cleaned = base64Str.trim();
  
  // If Cloudinary configured
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    try {
      const options = {
        folder: process.env.CLOUDINARY_FOLDER || 'artube',
        resource_type: 'auto'
      };
      const result = await cloudinary.uploader.upload(cleaned, options);
      return result.secure_url;
    } catch (err) {
      console.error('Cloudinary base64 upload error, falling back to local file:', err);
    }
  }

  // Local storage fallback
  try {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const matches = cleaned.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const base64Data = matches ? matches[2] : cleaned;
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `${prefix}-${Date.now()}-${Math.round(Math.random()*1e9)}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Failed to save base64 locally:', err);
    return '';
  }
};

// Middleware
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = String(req.headers['x-request-id'] || `srv-${startedAt.toString(36)}`);
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 400 || res.statusCode >= 400) {
      const route = String(req.originalUrl || req.url || '').split('?')[0];
      console.log(`[perf] ${req.method} ${route} ${res.statusCode} ${durationMs}ms id=${requestId}`);
    }
  });
  next();
});

// Session Middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
app.use('/uploads', express.static(uploadsDir));
app.use('/admin', express.static(path.join(__dirname, '../admin')));

// Connect to MongoDB
const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
  throw new Error('MONGODB_URI must be configured.');
}
let mongoDatabaseName = '';
try {
  mongoDatabaseName = new URL(mongoURI).pathname.replace(/^\/+/, '');
} catch (_err) {
  // Mongoose will report malformed connection strings with its normal startup error.
}
if (process.env.NODE_ENV === 'production' && (!mongoDatabaseName || mongoDatabaseName.toLowerCase() === 'test')) {
  throw new Error('Production MONGODB_URI must name an explicit non-test database.');
}
if (!mongoDatabaseName) {
  console.warn('[MongoDB] MONGODB_URI has no database name; MongoDB will use its default "test" database.');
}
mongoose.connect(mongoURI, {
  maxPoolSize: 20,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 8000,
})
  .then(() => {
    console.log('Connected to MongoDB successfully');
    // NOTE: seedDatabase() intentionally removed — it deleted real user content on every restart.
    // To reset dev data, set DEV_SEED=true in .env and run: node seed.js
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
  });

// ==========================================
// Real-Time WebSocket Server Setup
// ==========================================
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Map(); // socket -> { userId, username, activePostId }

function broadcast(event, payload, filterFn = null) {
  const msg = JSON.stringify({ type: event, ...payload, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(wsClients.get(client), client)) {
        client.send(msg);
      }
    }
  });
}

wss.on('connection', (ws, req) => {
  wsClients.set(ws, { userId: null, username: 'Guest', activePostId: null });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      const clientInfo = wsClients.get(ws) || {};

      switch (data.type) {
        case 'REGISTER':
        case 'AUTH':
          if (data.token) {
            verifyBackendToken(data.token).then((verified) => {
              if (verified) {
                clientInfo.userId = String(verified._id);
                clientInfo.username = verified.username || clientInfo.username;
              } else if (data.userId) {
                clientInfo.userId = String(data.userId);
                clientInfo.username = data.username || clientInfo.username;
              }
              wsClients.set(ws, clientInfo);
              if (clientInfo.userId) {
                Notification.countDocuments({ userId: clientInfo.userId, unread: true })
                  .then((unreadCount) => {
                    try {
                      ws.send(JSON.stringify({
                        type: 'REGISTERED',
                        userId: clientInfo.userId,
                        username: clientInfo.username,
                        unreadCount,
                      }));
                    } catch (_e) {}
                  })
                  .catch(() => {
                    try {
                      ws.send(JSON.stringify({ type: 'REGISTERED', userId: clientInfo.userId, username: clientInfo.username }));
                    } catch (_e) {}
                  });
              }
            }).catch(() => {
              if (data.userId) {
                clientInfo.userId = String(data.userId);
                clientInfo.username = data.username || clientInfo.username;
                wsClients.set(ws, clientInfo);
                try {
                  ws.send(JSON.stringify({ type: 'REGISTERED', userId: clientInfo.userId, username: clientInfo.username }));
                } catch (_e) {}
              }
            });
          } else {
            clientInfo.userId = data.userId ? String(data.userId) : clientInfo.userId;
            clientInfo.username = data.username || clientInfo.username;
            wsClients.set(ws, clientInfo);
            if (clientInfo.userId) {
              Notification.countDocuments({ userId: clientInfo.userId, unread: true })
                .then((unreadCount) => {
                  try {
                    ws.send(JSON.stringify({
                      type: 'REGISTERED',
                      userId: clientInfo.userId,
                      username: clientInfo.username,
                      unreadCount,
                    }));
                  } catch (_e) {}
                })
                .catch(() => {
                  try {
                    ws.send(JSON.stringify({ type: 'REGISTERED', userId: clientInfo.userId, username: clientInfo.username }));
                  } catch (_e) {}
                });
            } else {
              try {
                ws.send(JSON.stringify({ type: 'REGISTERED', userId: clientInfo.userId, username: clientInfo.username }));
              } catch (_e) {}
            }
          }
          break;

        case 'WATCHING_POST':
          clientInfo.activePostId = data.postId;
          wsClients.set(ws, clientInfo);
          break;

        case 'CHAT_MESSAGE':
          broadcast('CHAT_MESSAGE', {
            senderId: clientInfo.userId,
            senderName: clientInfo.username || data.senderName || 'Anonymous',
            avatarUrl: data.avatarUrl || '',
            text: data.text,
            roomId: data.roomId || 'global',
            courseId: data.courseId || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
          break;

        case 'LIVE_REACTION':
          broadcast('LIVE_REACTION', {
            postId: data.postId,
            reaction: data.reaction || '❤️',
            sender: clientInfo.username
          });
          break;

        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;
      }
    } catch (err) {
      console.warn('[WebSocket] Error parsing message:', err.message);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  // Welcome message
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Connected to Artube Live Stream Server' }));
});

// --- MODELS ---

// 0. User Schema
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, default: '' },
  authVersion: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  firebaseUid: { type: String, unique: true, sparse: true },
  displayName: { type: String, default: '' },
  bio: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  location: { type: String, default: '' },
  website: { type: String, default: '' },
  about: { type: String, default: '' },
  skills: [{ type: String }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
  isPrivate: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  restrictedWords: [{ type: String, trim: true, lowercase: true }],
  connectionRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  enrolledCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  profileVisitsCount: { type: Number, default: 0 },
  profileVisitors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  acceptTips: { type: Boolean, default: false },
  payout: {
    method: { type: String, enum: ['none', 'paypal', 'stripe', 'bank'], default: 'none' },
    paypalEmail: { type: String, default: '' },
    stripeAccount: { type: String, default: '' },
    bankDetails: { type: String, default: '' },
  },
  defaultLicense: { type: String, default: 'all-rights-reserved' },
  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, default: 'expo' },
    updatedAt: { type: Date, default: Date.now },
  }],
  radioFrequency: { type: String, default: undefined },
  radioEnabled: { type: Boolean, default: false },
  profileSetupCompleted: { type: Boolean, default: false },
  connectedAccounts: [{
    provider: { type: String, required: true },
    uid: { type: String, default: '' },
    email: { type: String, default: '' },
    connectedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
UserSchema.index(
  { radioFrequency: 1 },
  { unique: true, partialFilterExpression: { radioFrequency: { $type: 'string' } } }
);
UserSchema.index({ createdAt: -1 });
const User = mongoose.model('User', UserSchema);

const isProfileCompleted = (user) => {
  if (!user) return false;
  if (user.profileSetupCompleted === true) return true;
  if (user.profileSetupCompleted === false) return false;
  // For legacy users without the flag: consider complete if they have custom bio or avatar
  return Boolean(user.bio || user.about || (user.avatarUrl && !user.avatarUrl.includes('default')));
};

const toAuthenticatedUser = (user) => {
  const userObj = user.toObject ? user.toObject() : { ...user };
  userObj.id = userObj._id;
  userObj.profileSetupCompleted = isProfileCompleted(user);
  delete userObj.password;
  delete userObj.authVersion;
  return userObj;
};

const applyViewerContentFilters = (items, viewer) => {
  if (!Array.isArray(items)) return items;
  const blockedIds = new Set((viewer?.blockedUsers || []).map((id) => String(id)));
  const words = (viewer?.restrictedWords || [])
    .map((word) => String(word || '').trim().toLowerCase())
    .filter(Boolean);
  return items.filter((item) => {
    const author = item.userId && typeof item.userId === 'object' ? item.userId : null;
    if (author?.isBanned) return false;
    const authorId = String(author?._id || item.userId || '');
    if (authorId && blockedIds.has(authorId)) return false;
    if (!words.length) return true;
    const haystack = [
      item.title,
      item.description,
      item.author,
      item.artist,
      item.instructor,
      item.category,
      ...(Array.isArray(item.tags) ? item.tags : []),
    ].filter(Boolean).join(' ').toLowerCase();
    return !words.some((word) => haystack.includes(word));
  });
};

const serializeBlockedAccounts = (blockedUsers = []) => blockedUsers
  .filter(Boolean)
  .map((user) => {
    const obj = user.toObject ? user.toObject() : user;
    return {
      id: obj._id || obj.id,
      name: obj.displayName || obj.username || 'Artist',
      username: obj.username ? `@${String(obj.username).replace(/^@/, '')}` : '',
      avatar: obj.avatarUrl || null,
    };
  });

const toPublicUser = (user) => {
  const userObj = toAuthenticatedUser(user);
  delete userObj.email;
  delete userObj.firebaseUid;
  delete userObj.pushTokens;
  delete userObj.connectionRequests;
  delete userObj.sentRequests;
  delete userObj.blockedUsers;
  delete userObj.restrictedWords;
  return userObj;
};

const normalizeUsername = (value) => String(value ?? '')
  .trim()
  .replace(/^@+/, '')
  .toLowerCase()
  .replace(/[\s@]+/g, '_');

const isValidUsername = (username) => /^[a-z0-9_]{3,30}$/.test(username);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePageLimit = (query = {}, defaultLimit = 50, maxLimit = 100) => {
  const requested = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), maxLimit) : defaultLimit;
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};

const isUsernameAvailable = async (username, excludeUserId = null) => {
  const normalized = normalizeUsername(username);
  if (!normalized) return false;
  const query = { username: new RegExp(`^${escapeRegex(normalized)}$`, 'i') };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  return !(await User.exists(query));
};

const createUserSessionToken = (user) => jwt.sign(
  { sub: String(user._id), id: String(user._id), ver: Number(user.authVersion || 0) },
  JWT_SECRET,
  { expiresIn: '30d' }
);

const verifyBackendToken = async (token) => {
  const decoded = jwt.verify(token, JWT_SECRET);
  const userId = decoded.sub || decoded.id;
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return null;
  const user = await User.findById(userId).select('-password');
  if (!user || Number(decoded.ver || 0) !== Number(user.authVersion || 0)) return null;
  return user;
};

// Middleware to verify session or JWT token (Strict Auth)
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!bearerMatch) return res.status(401).json({ error: 'Invalid authorization header.' });
      const token = bearerMatch[1];
      const user = await verifyBackendToken(token);
      if (user) {
        req.user = user;
        req.authToken = token;
        return next();
      }
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId).select('-password');
      if (user && Number(req.session.authVersion || 0) === Number(user.authVersion || 0)) {
        req.user = user;
        return next();
      }
    }

    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

const authenticateIfProvided = (req, res, next) => {
  if (!req.headers.authorization && !req.session?.userId) return next();
  return authenticateUser(req, res, next);
};

// --- RADIO CHANNELS ---
const RadioChannelSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  frequency: { type: String, required: true },
  channelName: { type: String, required: true },
  isLive: { type: Boolean, default: false, index: true },
  startedAt: { type: Date, default: null },
  lastHeartbeatAt: { type: Date, default: null },
}, { timestamps: true });
RadioChannelSchema.index({ frequency: 1 }, { unique: true });
RadioChannelSchema.index({ ownerId: 1 }, { unique: true });
const RadioChannel = mongoose.model('RadioChannel', RadioChannelSchema);

const RADIO_FREQUENCY_PATTERN = /^\d{3}\.\d$/;
const radioPresence = new Map(); // frequency -> userId -> Set(socketId)
const radioBroadcasters = new Map(); // frequency -> { socketId, userId }
const radioRoomName = (frequency) => `radio:${frequency}`;
const normalizeRadioFrequency = (value) => {
  const frequency = String(value ?? '').trim();
  if (!RADIO_FREQUENCY_PATTERN.test(frequency)) return null;
  const numeric = Number(frequency);
  return numeric >= 100 && numeric <= 199.9 ? numeric.toFixed(1) : null;
};
const assignUniqueRadioFrequency = async (userId) => {
  const [users, channels] = await Promise.all([
    User.find({ radioFrequency: { $type: 'string' } }).select('radioFrequency').lean(),
    RadioChannel.find({}).select('frequency').lean(),
  ]);
  const taken = new Set();
  for (const row of users) {
    const freq = normalizeRadioFrequency(row.radioFrequency);
    if (freq) taken.add(freq);
  }
  for (const row of channels) {
    const freq = normalizeRadioFrequency(row.frequency);
    if (freq) taken.add(freq);
  }
  const hex = String(userId).replace(/[^a-fA-F0-9]/g, '').slice(-6) || '0';
  const parsed = parseInt(hex, 16);
  let slot = Number.isFinite(parsed) ? parsed % 1000 : 0;
  for (let step = 0; step < 1000; step += 1) {
    const frequency = (100 + ((slot + step) % 1000) / 10).toFixed(1);
    if (!taken.has(frequency)) return frequency;
  }
  return null;
};

const repairRadioFrequencyCollisions = async () => {
  const users = await User.find({ radioFrequency: { $type: 'string' } })
    .sort({ createdAt: 1 })
    .select('_id radioFrequency');
  const ownerByFrequency = new Map();
  for (const user of users) {
    const current = normalizeRadioFrequency(user.radioFrequency);
    const takenByOther = current && ownerByFrequency.get(current) && ownerByFrequency.get(current) !== String(user._id);
    if (!current || takenByOther) {
      const next = await assignUniqueRadioFrequency(user._id);
      if (!next) continue;
      user.radioFrequency = next;
      user.radioEnabled = true;
      await user.save();
      ownerByFrequency.set(next, String(user._id));
      const owned = await RadioChannel.findOne({ ownerId: user._id });
      if (owned && owned.frequency !== next) {
        owned.frequency = next;
        await owned.save().catch(async () => {
          await RadioChannel.deleteOne({ _id: owned._id });
        });
      }
      console.log(`[Radio] Moved ${user._id} off a shared frequency onto ${next}`);
      continue;
    }
    if (user.radioFrequency !== current) {
      user.radioFrequency = current;
      await user.save();
    }
    ownerByFrequency.set(current, String(user._id));
  }

  const channels = await RadioChannel.find({});
  const seenFreq = new Set();
  for (const channel of channels) {
    const freq = normalizeRadioFrequency(channel.frequency);
    const rightful = freq && ownerByFrequency.get(freq);
    if (!freq || rightful !== String(channel.ownerId) || seenFreq.has(freq)) {
      await RadioChannel.deleteOne({ _id: channel._id });
      continue;
    }
    if (channel.frequency !== freq) {
      channel.frequency = freq;
      await channel.save();
    }
    seenFreq.add(freq);
  }
};

const getRadioListenerCount = (frequency) => radioPresence.get(frequency)?.size || 0;
const emitRadioListenerCount = (frequency) => {
  io.to(radioRoomName(frequency)).emit('radio:listener-count', {
    frequency,
    listenerCount: getRadioListenerCount(frequency),
  });
};
const clearRadioListeners = (frequency) => {
  radioBroadcasters.delete(frequency);
  const listeners = radioPresence.get(frequency);
  if (listeners) {
    for (const socketIds of listeners.values()) {
      for (const socketId of socketIds) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.data.radioFrequency = null;
          socket.leave(radioRoomName(frequency));
        }
      }
    }
  }
  radioPresence.delete(frequency);
  emitRadioListenerCount(frequency);
};

// Create the uniqueness constraints explicitly before allowing activation. Clear
// live flags on process startup because an in-memory media session cannot survive it.
const radioIndexesReady = mongoose.connection.asPromise()
  .then(async () => {
    await repairRadioFrequencyCollisions();
    await Promise.all([
      User.collection.createIndex(
        { radioFrequency: 1 },
        { unique: true, partialFilterExpression: { radioFrequency: { $type: 'string' } } }
      ),
      RadioChannel.collection.createIndex({ frequency: 1 }, { unique: true }),
      RadioChannel.collection.createIndex({ ownerId: 1 }, { unique: true }),
    ]);
    await RadioChannel.updateMany(
      { isLive: true },
      { $set: { isLive: false, startedAt: null, lastHeartbeatAt: null } }
    );
    return true;
  })
  .catch((err) => {
    console.error('[Radio] Could not prepare channel indexes:', err.message);
    return false;
  });

const findRadioUserFromToken = async (token) => {
  if (!token) return null;

  try {
    return await verifyBackendToken(token);
  } catch (_tokenError) {
    return null;
  }
};

const authenticateRadioUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    let user = await findRadioUserFromToken(token);
    if (!user && req.session?.userId) {
      const sessionUser = await User.findById(req.session.userId).select('-password');
      if (sessionUser && Number(req.session.authVersion || 0) === Number(sessionUser.authVersion || 0)) {
        user = sessionUser;
      }
    }
    if (!user) return res.status(401).json({ error: 'Sign in with a valid account to use Artwave Radio.' });
    req.user = user;
    next();
  } catch (err) {
    console.error('[Radio] Authentication failed:', err.message);
    res.status(500).json({ error: 'Could not verify your Artwave Radio session.' });
  }
};

const formatRadioChannel = async (channel) => {
  if (!channel) return null;
  const owner = await User.findById(channel.ownerId).select('displayName username avatarUrl').lean();
  return {
    id: String(channel._id),
    ownerId: String(channel.ownerId),
    displayName: owner?.displayName || owner?.username || 'Artwave artist',
    username: owner?.username || '',
    avatarUrl: owner?.avatarUrl || '',
    frequency: channel.frequency,
    channelName: channel.channelName,
    isLive: Boolean(channel.isLive),
    startedAt: channel.startedAt,
    listenerCount: getRadioListenerCount(channel.frequency),
  };
};

const formatRadioChannels = async (channels = []) => {
  const ids = [...new Set(channels.map((channel) => String(channel.ownerId || '')).filter(Boolean))];
  const owners = ids.length
    ? await User.find({ _id: { $in: ids } }).select('displayName username avatarUrl').lean()
    : [];
  const byId = new Map(owners.map((user) => [String(user._id), user]));
  return channels.map((channel) => {
    const owner = byId.get(String(channel.ownerId));
    return {
      id: String(channel._id),
      ownerId: String(channel.ownerId),
      displayName: owner?.displayName || owner?.username || 'Artwave artist',
      username: owner?.username || '',
      avatarUrl: owner?.avatarUrl || '',
      frequency: channel.frequency,
      channelName: channel.channelName,
      isLive: Boolean(channel.isLive),
      startedAt: channel.startedAt,
      listenerCount: getRadioListenerCount(channel.frequency),
    };
  });
};

const ensureRadioChannelForUser = async (user) => {
  if (!user.radioFrequency) return null;
  const defaultName = `${user.displayName || user.username || 'Artist'}'s Radio`;
  const channel = await RadioChannel.findOneAndUpdate(
    { frequency: user.radioFrequency },
    { $setOnInsert: { ownerId: user._id, frequency: user.radioFrequency, channelName: defaultName } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (String(channel.ownerId) !== String(user._id)) {
    const err = new Error('This frequency is already linked to a different channel owner.');
    err.status = 409;
    throw err;
  }
  return channel;
};

const sendRadioError = (ack, code, message) => {
  if (typeof ack === 'function') ack({ ok: false, code, message });
};

const removeRadioSocket = (socket) => {
  const frequency = socket.data?.radioFrequency;
  const userId = socket.data?.userId;
  if (!frequency || !userId) return;

  const broadcaster = radioBroadcasters.get(frequency);
  if (broadcaster && broadcaster.socketId === socket.id) {
    radioBroadcasters.delete(frequency);
    RadioChannel.findOneAndUpdate(
      { frequency },
      { $set: { isLive: false, startedAt: null, lastHeartbeatAt: null } }
    ).catch(() => {});
    io.emit('radio:broadcast-stopped', { frequency });
    io.emit('radio:channel-status', { frequency, isLive: false });
    console.log(`📻 [Radio] Channel ${frequency} broadcaster disconnected. Channel marked OFFLINE.`);
    clearRadioListeners(frequency);
    return;
  }

  if (broadcaster && broadcaster.socketId !== socket.id) {
    io.to(broadcaster.socketId).emit('radio:listener-left', {
      listenerSocketId: socket.id,
      userId,
      frequency,
    });
  }

  const listeners = radioPresence.get(frequency);
  const sockets = listeners?.get(userId);
  sockets?.delete(socket.id);
  if (sockets?.size === 0) listeners.delete(userId);
  if (listeners?.size === 0) radioPresence.delete(frequency);
  socket.leave(radioRoomName(frequency));
  socket.data.radioFrequency = null;
  emitRadioListenerCount(frequency);
};

io.use(async (socket, next) => {
  try {
    const rawToken = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
    const token = rawToken?.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
    let user = null;
    if (token) {
      user = await findRadioUserFromToken(token);
    }
    if (user) {
      socket.data.userId = String(user._id);
      socket.data.user = user;
    } else {
      socket.data.userId = `listener_${socket.id}`;
      socket.data.isGuest = true;
    }
    next();
  } catch (err) {
    socket.data.userId = `listener_${socket.id}`;
    socket.data.isGuest = true;
    next();
  }
});

io.on('connection', (socket) => {
  socket.data.radioFrequency = null;
  socket.data.isBroadcaster = false;
  if (!socket.data.isGuest && socket.data.userId) {
    socket.join(`user:${socket.data.userId}`);
  }

  socket.on('radio:create', async (payload = {}, ack) => {
    const frequency = normalizeRadioFrequency(payload.frequency);
    if (!frequency) return sendRadioError(ack, 'INVALID_FREQUENCY', 'Enter a valid frequency.');
    try {
      const channel = await RadioChannel.findOne({ frequency });
      if (!channel) return sendRadioError(ack, 'CHANNEL_NOT_FOUND', 'No Artwave Radio channel uses this frequency.');
      if (socket.data.isGuest || !socket.data.userId || String(channel.ownerId) !== String(socket.data.userId)) {
        return sendRadioError(ack, 'FORBIDDEN', 'Only the channel owner can broadcast on this frequency.');
      }
      const previous = radioBroadcasters.get(frequency);
      if (previous && previous.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(previous.socketId);
        if (oldSocket) {
          oldSocket.data.isBroadcaster = false;
          oldSocket.leave(radioRoomName(frequency));
        }
        radioBroadcasters.delete(frequency);
      }

      channel.isLive = true;
      channel.startedAt = new Date();
      channel.lastHeartbeatAt = new Date();
      await channel.save();

      // Notify followers of live radio broadcast
      User.findById(channel.ownerId).select('displayName username avatarUrl followers')
        .then((broadcaster) => {
          if (!broadcaster) return;
          const broadcasterName = broadcaster.displayName || broadcaster.username || 'An artist';
          notifyFollowers(channel.ownerId, {
            type: 'radio_live',
            title: 'Artwave Radio Live',
            action: `is now live on Artwave Radio (${channel.frequency} MHz)`,
            text: `${broadcasterName} is now live on Artwave Radio (${channel.frequency} MHz)`,
            channelFrequency: channel.frequency,
          });
        })
        .catch((e) => console.warn('[Radio] Follower notify note:', e.message));

      radioBroadcasters.set(frequency, { socketId: socket.id, userId: socket.data.userId });
      socket.data.radioFrequency = frequency;
      socket.data.isBroadcaster = true;
      await socket.join(radioRoomName(frequency));

      io.emit('radio:channel-status', { frequency, isLive: true });
      io.emit('radio:broadcast-started', { frequency, broadcasterSocketId: socket.id });
      console.log(`📻 [Radio] Channel ${frequency} is now LIVE (Broadcaster: ${socket.id}, Owner: ${socket.data.userId})`);

      if (typeof ack === 'function') {
        ack({ ok: true, frequency, isLive: true, socketId: socket.id });
      }
    } catch (err) {
      console.error('[Radio] Create broadcast failed:', err.message);
      sendRadioError(ack, 'CREATE_FAILED', 'Could not start broadcast signaling.');
    }
  });

  socket.on('radio:join', async (payload = {}, ack) => {
    const frequency = normalizeRadioFrequency(payload.frequency);
    if (!frequency) return sendRadioError(ack, 'INVALID_FREQUENCY', 'Enter a frequency such as 102.5.');
    try {
      const channel = await RadioChannel.findOne({ frequency });
      if (!channel) return sendRadioError(ack, 'CHANNEL_NOT_FOUND', 'No Artwave Radio channel uses this frequency.');
      if (!channel.isLive) return sendRadioError(ack, 'CHANNEL_OFFLINE', 'This channel is currently offline.');

      removeRadioSocket(socket);
      await socket.join(radioRoomName(frequency));
      socket.data.radioFrequency = frequency;
      socket.data.isBroadcaster = false;

      if (!radioPresence.has(frequency)) radioPresence.set(frequency, new Map());
      const listeners = radioPresence.get(frequency);
      if (!listeners.has(socket.data.userId)) listeners.set(socket.data.userId, new Set());
      listeners.get(socket.data.userId).add(socket.id);

      const broadcaster = radioBroadcasters.get(frequency);
      if (broadcaster && broadcaster.socketId !== socket.id) {
        io.to(broadcaster.socketId).emit('radio:listener-joined', {
          listenerSocketId: socket.id,
          userId: socket.data.userId,
          frequency,
        });
      }

      if (typeof ack === 'function') {
        ack({
          ok: true,
          frequency,
          listenerCount: listeners.size,
          broadcasterSocketId: broadcaster ? broadcaster.socketId : null,
        });
      }
      emitRadioListenerCount(frequency);
    } catch (err) {
      console.error('[Radio] Join failed:', err.message);
      sendRadioError(ack, 'JOIN_FAILED', 'Could not join this channel. Try again.');
    }
  });

  socket.on('radio:offer', (payload = {}, ack) => {
    const { toSocketId, sdp, frequency } = payload;
    const broadcaster = frequency && radioBroadcasters.get(frequency);
    if (broadcaster && broadcaster.socketId !== socket.id && !socket.data.isBroadcaster) {
      return sendRadioError(ack, 'FORBIDDEN', 'Only the channel broadcaster can send offers.');
    }
    if (!toSocketId || !sdp) {
      return sendRadioError(ack, 'INVALID_PAYLOAD', 'Recipient socket ID and SDP are required.');
    }
    io.to(toSocketId).emit('radio:offer', {
      fromSocketId: socket.id,
      sdp,
      frequency,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('radio:answer', (payload = {}, ack) => {
    const { toSocketId, sdp, frequency } = payload;
    if (!toSocketId || !sdp) {
      return sendRadioError(ack, 'INVALID_PAYLOAD', 'Recipient socket ID and SDP are required.');
    }
    io.to(toSocketId).emit('radio:answer', {
      fromSocketId: socket.id,
      sdp,
      frequency,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('radio:ice-candidate', (payload = {}, ack) => {
    const { toSocketId, candidate, frequency } = payload;
    if (!toSocketId || !candidate) {
      return sendRadioError(ack, 'INVALID_PAYLOAD', 'Recipient socket ID and candidate are required.');
    }
    io.to(toSocketId).emit('radio:ice-candidate', {
      fromSocketId: socket.id,
      candidate,
      frequency,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('radio:stop', async (payload = {}, ack) => {
    const frequency = normalizeRadioFrequency(payload?.frequency || socket.data.radioFrequency);
    if (!frequency) return sendRadioError(ack, 'INVALID_FREQUENCY', 'Enter a valid frequency.');
    const broadcaster = radioBroadcasters.get(frequency);
    if (broadcaster && broadcaster.socketId !== socket.id && broadcaster.userId !== socket.data.userId) {
      return sendRadioError(ack, 'FORBIDDEN', 'Only the broadcaster can stop the broadcast.');
    }

    try {
      await RadioChannel.findOneAndUpdate(
        { frequency },
        { $set: { isLive: false, startedAt: null, lastHeartbeatAt: null } }
      );
    } catch (_e) {}

    radioBroadcasters.delete(frequency);
    io.emit('radio:broadcast-stopped', { frequency });
    io.emit('radio:channel-status', { frequency, isLive: false });
    console.log(`📻 [Radio] Channel ${frequency} broadcast stopped via socket`);
    clearRadioListeners(frequency);
    if (typeof ack === 'function') ack({ ok: true, frequency });
  });

  socket.on('radio:leave', (_payload, ack) => {
    const frequency = socket.data.radioFrequency;
    removeRadioSocket(socket);
    if (typeof ack === 'function') ack({ ok: true, frequency });
  });

  socket.on('radio:heartbeat', (_payload, ack) => {
    const frequency = socket.data.radioFrequency;
    const listeners = frequency && radioPresence.get(frequency);
    const sockets = listeners?.get(socket.data.userId);
    if (!sockets?.has(socket.id)) return sendRadioError(ack, 'NOT_JOINED', 'Join a live channel before sending presence updates.');
    if (typeof ack === 'function') ack({ ok: true, frequency });
  });

  socket.on('disconnect', () => removeRadioSocket(socket));
});

app.get('/api/radio/me', authenticateRadioUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    const channel = user.radioFrequency ? await ensureRadioChannelForUser(user) : null;
    res.json({
      radioEnabled: Boolean(user.radioEnabled),
      frequency: user.radioFrequency || null,
      channel: await formatRadioChannel(channel),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load your radio profile.' });
  }
});

app.post('/api/radio/activate', authenticateRadioUser, async (req, res) => {
  try {
    if (!(await radioIndexesReady)) {
      return res.status(503).json({ error: 'Radio channel storage is not ready. Please try again.' });
    }
    let user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User account not found.' });
    if (!user.radioFrequency) {
      const frequency = await assignUniqueRadioFrequency(user._id);
      if (!frequency) {
        return res.status(503).json({ error: 'Could not assign a radio frequency. Please try again.' });
      }
      try {
        const updated = await User.findOneAndUpdate(
          { _id: user._id, $or: [{ radioFrequency: { $exists: false } }, { radioFrequency: null }] },
          { $set: { radioFrequency: frequency, radioEnabled: true } },
          { new: true }
        );
        user = updated || await User.findById(req.user._id);
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const retry = await assignUniqueRadioFrequency(user._id);
        if (!retry) return res.status(503).json({ error: 'Could not assign a radio frequency. Please try again.' });
        user = await User.findOneAndUpdate(
          { _id: user._id, $or: [{ radioFrequency: { $exists: false } }, { radioFrequency: null }] },
          { $set: { radioFrequency: retry, radioEnabled: true } },
          { new: true }
        );
      }
      if (!user?.radioFrequency) {
        return res.status(503).json({ error: 'Could not assign a radio frequency. Please try again.' });
      }
    }
    if (!user.radioEnabled) {
      user.radioEnabled = true;
      await user.save();
    }
    const channel = await ensureRadioChannelForUser(user);
    res.status(200).json({ radioEnabled: true, frequency: user.radioFrequency, channel: await formatRadioChannel(channel) });
  } catch (err) {
    console.error('[Radio] Activation failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not activate Artwave Radio.' });
  }
});

app.get('/api/radio/channels', async (req, res) => {
  try {
    const channels = await RadioChannel.find({}).sort({ isLive: -1, updatedAt: -1 }).limit(50);
    const results = await formatRadioChannels(channels);
    res.json({ channels: results.filter(Boolean) });
  } catch (err) {
    console.error('[Radio] Fetch channels failed:', err.message);
    res.status(500).json({ error: 'Could not load Artwave Radio channels.' });
  }
});

app.get('/api/radio/search', async (req, res) => {
  try {
    const frequency = req.query.frequency ? normalizeRadioFrequency(req.query.frequency) : null;
    const username = String(req.query.username || '').trim();
    if (req.query.frequency && !frequency) return res.status(400).json({ error: 'Enter a frequency between 100.0 and 199.9, such as 102.5.' });

    let channels = [];
    if (frequency) {
      const channel = await RadioChannel.findOne({ frequency });
      if (channel) channels = [channel];
    } else if (username) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const users = await User.find({
        radioFrequency: { $type: 'string' },
        $or: [
          { username: new RegExp(escaped, 'i') },
          { displayName: new RegExp(escaped, 'i') },
        ],
      }).limit(20);
      channels = await RadioChannel.find({ ownerId: { $in: users.map((user) => user._id) } }).limit(20);
    } else {
      channels = await RadioChannel.find({}).sort({ isLive: -1, updatedAt: -1 }).limit(20);
    }
    const results = await formatRadioChannels(channels);
    res.json({ channels: results.filter(Boolean) });
  } catch (err) {
    console.error('[Radio] Search failed:', err.message);
    res.status(500).json({ error: 'Could not search Artwave Radio channels.' });
  }
});

app.get('/api/radio/channels/:frequency', async (req, res) => {
  const frequency = normalizeRadioFrequency(req.params.frequency);
  console.log(`📻 [Radio API] GET channel by frequency: "${req.params.frequency}" -> normalized: "${frequency}"`);
  if (!frequency) return res.status(400).json({ error: 'Enter a frequency between 100.0 and 199.9, such as 102.5.' });
  try {
    const channel = await RadioChannel.findOne({ frequency });
    if (!channel) {
      console.log(`📻 [Radio API] Channel ${frequency} NOT FOUND in database`);
      return res.status(404).json({ error: 'No Artwave Radio channel uses this frequency.' });
    }
    const formatted = await formatRadioChannel(channel);
    console.log(`📻 [Radio API] Channel ${frequency} found: "${formatted?.displayName}" | isLive: ${formatted?.isLive}`);
    res.json({ channel: formatted });
  } catch (err) {
    console.error(`📻 [Radio API] Channel ${frequency} error:`, err.message);
    res.status(500).json({ error: 'Could not load this Artwave Radio channel.' });
  }
});

app.get('/api/radio/channels/:frequency/status', async (req, res) => {
  const frequency = normalizeRadioFrequency(req.params.frequency);
  console.log(`📻 [Radio API] GET status for frequency: "${req.params.frequency}"`);
  if (!frequency) return res.status(400).json({ error: 'Enter a frequency between 100.0 and 199.9, such as 102.5.' });
  try {
    const channel = await RadioChannel.findOne({ frequency });
    if (!channel) return res.status(404).json({ error: 'No Artwave Radio channel uses this frequency.' });
    const formatted = await formatRadioChannel(channel);
    console.log(`📻 [Radio API] Channel ${frequency} status: isLive=${formatted?.isLive}, listeners=${formatted?.listenerCount}`);
    res.json({ channel: formatted });
  } catch (_err) {
    res.status(500).json({ error: 'Could not load this channel status.' });
  }
});

app.get('/api/radio/channels/:frequency/listeners', async (req, res) => {
  const frequency = normalizeRadioFrequency(req.params.frequency);
  if (!frequency) return res.status(400).json({ error: 'Enter a valid radio frequency.' });
  try {
    const channel = await RadioChannel.findOne({ frequency }).select('_id frequency');
    if (!channel) return res.status(404).json({ error: 'No Artwave Radio channel uses this frequency.' });
    res.json({ frequency, listenerCount: getRadioListenerCount(frequency) });
  } catch (_err) {
    res.status(500).json({ error: 'Could not load listener presence.' });
  }
});

app.post('/api/radio/channels/:frequency/start', authenticateRadioUser, async (req, res) => {
  const frequency = normalizeRadioFrequency(req.params.frequency);
  if (!frequency) return res.status(400).json({ error: 'Enter a valid radio frequency.' });
  try {
    const channel = await RadioChannel.findOne({ frequency });
    if (!channel) return res.status(404).json({ error: 'No Artwave Radio channel uses this frequency.' });
    if (String(channel.ownerId) !== String(req.user._id)) return res.status(403).json({ error: 'Only this channel owner can broadcast.' });
    
    channel.isLive = true;
    channel.startedAt = new Date();
    channel.lastHeartbeatAt = new Date();
    await channel.save();
    
    // Notify followers of live radio broadcast
    const broadcasterName = req.user.displayName || req.user.username || 'An artist';
    notifyFollowers(channel.ownerId, {
      type: 'radio_live',
      title: 'Artwave Radio Live',
      action: `is now live on Artwave Radio (${channel.frequency} MHz)`,
      text: `${broadcasterName} is now live on Artwave Radio (${channel.frequency} MHz)`,
      channelFrequency: channel.frequency,
    }).catch((e) => console.warn('[Radio] Follower notify note:', e.message));

    io.emit('radio:channel-status', { frequency, isLive: true });
    io.emit('radio:broadcast-started', { frequency });
    console.log(`📻 [Radio API] Channel ${frequency} broadcast started by owner ${req.user._id}`);
    
    const formatted = await formatRadioChannel(channel);
    return res.json({ radioEnabled: true, frequency: channel.frequency, channel: formatted });
  } catch (_err) {
    res.status(500).json({ error: 'Could not authorize this broadcast.' });
  }
});

app.post('/api/radio/channels/:frequency/stop', authenticateRadioUser, async (req, res) => {
  const frequency = normalizeRadioFrequency(req.params.frequency);
  if (!frequency) return res.status(400).json({ error: 'Enter a valid radio frequency.' });
  try {
    const channel = await RadioChannel.findOne({ frequency });
    if (!channel) return res.status(404).json({ error: 'No Artwave Radio channel uses this frequency.' });
    if (String(channel.ownerId) !== String(req.user._id)) return res.status(403).json({ error: 'Only this channel owner can stop its broadcast.' });
    channel.isLive = false;
    channel.startedAt = null;
    channel.lastHeartbeatAt = null;
    await channel.save();
    io.emit('radio:channel-status', { frequency, isLive: false });
    io.emit('radio:broadcast-stopped', { frequency });
    console.log(`📻 [Radio API] Channel ${frequency} broadcast stopped by owner ${req.user._id}`);
    clearRadioListeners(frequency);
    res.json({ channel: await formatRadioChannel(channel) });
  } catch (_err) {
    res.status(500).json({ error: 'Could not stop this channel.' });
  }
});

// 1. Post Schema
const PostSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, default: 'artwork' },
  category: { type: String, default: 'explore' },
  tag: { type: String, default: 'Art' },
  author: { type: String, default: '' },
  avatarSvg: { type: String, default: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#1b5fa8"/><ellipse cx="12" cy="17" rx="6" ry="4" fill="white" opacity="0.85"/><circle cx="12" cy="9" r="3" fill="white" opacity="0.95"/></svg>' },
  avatarUrl: { type: String, default: '' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userEmail: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  artSvg: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  mediaUrls: { type: [String], default: [] },
  images: { type: [String], default: [] },
  mediaType: { type: String, default: '' },
  duration: { type: String, default: '' },
  videoDuration: { type: String, default: '' },
  extraMediaUrl: { type: String, default: '' },
  extraMediaType: { type: String, default: '' },
  thumbnailUrl: { type: String, default: '' },
  thumbnailMediaType: { type: String, default: '' },
  bunnyVideoId: { type: String, default: '' },
  bunnyLibraryId: { type: Number, default: 0 },
  hlsUrl: { type: String, default: '' },
  mp4Url: { type: String, default: '' },
  previewUrl: { type: String, default: '' },
  embedUrl: { type: String, default: '' },
  views: { type: String, default: '0 views' },
  viewsCount: { type: Number, default: 0 },
  time: { type: String, default: 'Just now' },
  likesCount: { type: Number, default: 0 },
  isLiked: { type: Boolean, default: false },
  description: { type: String, default: '' },
  tutorialDuration: { type: String, default: '' },
  tutorialLessons: { type: String, default: '' },
  medium: { type: String, default: '' },
  attachedCourse: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
  visibility: { type: String, default: 'public' },
  scheduledTime: { type: Date, default: null },
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    author: { type: String, default: 'Anonymous' },
    avatarUrl: { type: String, default: '' },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
  }],
  createdAt: { type: Date, default: Date.now }
});
PostSchema.index({ userId: 1, visibility: 1, createdAt: -1 });
PostSchema.index({ visibility: 1, createdAt: -1 });
PostSchema.index({ createdAt: -1 });
const Post = mongoose.model('Post', PostSchema);

// 2. Artist Schema
const ArtistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  bio: { type: String, default: 'Digital Artist' },
  avatar: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  followers: { type: String, default: '0' },
  createdAt: { type: Date, default: Date.now }
});
const Artist = mongoose.model('Artist', ArtistSchema);

// 3. Video Schema
const VideoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, default: '' },
  avatar: { type: String, default: '' },
  duration: { type: String, default: '05:00' },
  artSvg: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  mediaType: { type: String, default: '' },
  bunnyVideoId: { type: String, default: '' },
  bunnyLibraryId: { type: Number, default: 0 },
  hlsUrl: { type: String, default: '' },
  mp4Url: { type: String, default: '' },
  previewUrl: { type: String, default: '' },
  embedUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const Video = mongoose.model('Video', VideoSchema);

// 4. Course Schema
const CourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, default: '' },
  avatar: { type: String, default: '' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userEmail: { type: String, default: '' },
  level: { type: String, default: 'Beginner' },
  difficulty: { type: String, default: 'Beginner' },
  progress: { type: Number, default: 0 },
  artSvg: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  image: { type: String, default: '' },
  thumbnailUrl: { type: String, default: '' },
  mediaType: { type: String, default: 'video' },
  bunnyVideoId: { type: String, default: '' },
  bunnyLibraryId: { type: Number, default: 0 },
  hlsUrl: { type: String, default: '' },
  mp4Url: { type: String, default: '' },
  proxyUrl: { type: String, default: '' },
  previewUrl: { type: String, default: '' },
  embedUrl: { type: String, default: '' },
  images: [{ type: String }],
  mediaUrls: [{ type: String }],
  relatedImages: [{ type: String }],
  description: { type: String, default: '' },
  whatYouLearn: [{ type: String }],
  learnItems: [{ type: String }],
  rating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  enrolled: { type: String, default: '0 enrolled' },
  enrolledCount: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
  enrolledStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  duration: { type: String, default: '' },
  category: { type: String, default: 'Digital Art' },
  price: { type: String, default: 'Free' },
  avatarUrl: { type: String, default: '' },
  instructor: { type: String, default: '' },
  lessons: [{
    id: { type: String, default: '' },
    title: { type: String, default: '' },
    duration: { type: String, default: '10:00' },
    mediaUrl: { type: String, default: '' },
    mediaType: { type: String, default: 'video' },
    isCompleted: { type: Boolean, default: false }
  }],
  visibility: { type: String, default: 'public' },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true, strict: false });
CourseSchema.index({ userId: 1, createdAt: -1 });
CourseSchema.index({ visibility: 1, createdAt: -1 });
const Course = mongoose.model('Course', CourseSchema);

// 5. Community Schema
const CommunitySchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  bannerUrl: { type: String, default: '' },
  membersCount: { type: Number, default: 1 },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  creator: { type: String, default: 'Community Admin' },
  tags: [String],
  createdAt: { type: Date, default: Date.now }
});
const Community = mongoose.model('Community', CommunitySchema);

// 6. Challenge Schema
const ChallengeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  rules: { type: String, default: '' },
  reward: { type: String, default: '500 Creative Points' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: () => new Date(+new Date() + 14*24*60*60*1000) },
  status: { type: String, enum: ['active', 'upcoming', 'ended'], default: 'active' },
  bannerUrl: { type: String, default: '' },
  participantsCount: { type: Number, default: 0 },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  submissions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    author: { type: String, default: '' },
    submittedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const Challenge = mongoose.model('Challenge', ChallengeSchema);

// 5. Notification Schema
const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  user: { type: String, default: 'Someone' },
  action: { type: String, default: '' },
  text: { type: String, required: true },
  avatarUrl: { type: String, default: '' },
  type: {
    type: String,
    enum: [
      'follow',
      'new_connection',
      'connection_request',
      'connection_accepted',
      'new_content',
      'new_video',
      'new_course',
      'radio_live',
      'radio_ended',
      'like',
      'comment',
      'general'
    ],
    default: 'general',
    index: true
  },
  title: { type: String, default: 'Notification' },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  channelFrequency: { type: String, default: '' },
  unread: { type: Boolean, default: true, index: true },
  isRead: { type: Boolean, default: false },
  time: { type: String, default: 'Just now' },
  createdAt: { type: Date, default: Date.now, index: true }
});

NotificationSchema.pre('save', function (next) {
  if (this.isModified('unread')) {
    this.isRead = !this.unread;
  } else if (this.isModified('isRead')) {
    this.unread = !this.isRead;
  }
  next();
});

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, unread: 1 });
NotificationSchema.index({ userId: 1, actorId: 1, type: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', NotificationSchema);

// --- MULTER STORAGE CONFIG ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const MAX_VIDEO_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
const upload = multer({ storage: storage, limits: { fileSize: MAX_VIDEO_UPLOAD_BYTES } });

const makeMediaUrlPublic = (req, value) => {
  if (typeof value !== 'string' || !value.startsWith('/uploads/')) return value;
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0];
  const publicBaseUrl = (process.env.PUBLIC_API_URL || `${forwardedProtocol || req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${publicBaseUrl}${value}`;
};


// --- CRUD API ENDPOINTS ---

// Server Health Check endpoint for connectivity verification
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Artube backend server is reachable',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// --- PUSH NOTIFICATIONS (EXPO PUSH API) ---
const sendPushToUser = async (userId, { title, body, data }) => {
  try {
    if (!userId) return;
    const user = await User.findById(userId).select('pushTokens displayName username');
    if (!user || !Array.isArray(user.pushTokens) || user.pushTokens.length === 0) return;

    const messages = user.pushTokens
      .filter((t) => t && t.token && (t.token.startsWith('ExponentPushToken') || t.token.startsWith('ExpoPushToken')))
      .map((t) => ({
        to: t.token,
        sound: 'default',
        title: title || 'Artube',
        body: body || '',
        data: data || {},
        channelId: 'artube-alerts',
        priority: 'high',
        badge: 1,
        ttl: 3600,
        interruptionLevel: 'timeSensitive',
      }));

    if (messages.length === 0) return;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.warn('[PushNotification] Error sending push notification:', err.message);
  }
};

// --- CENTRALIZED NOTIFICATION CREATION & REAL-TIME DISPATCH ---
async function createAndDispatchNotification({
  userId,
  actorId = null,
  user = 'Someone',
  avatarUrl = '',
  type = 'general',
  title = 'Notification',
  action = '',
  text = '',
  postId = null,
  courseId = null,
  requesterId = null,
  channelFrequency = '',
  preventDuplicatesWithinMs = 0,
}) {
  try {
    if (!userId) return null;
    if (actorId && String(userId) === String(actorId)) {
      // Do not notify oneself
      return null;
    }

    if (preventDuplicatesWithinMs > 0) {
      const windowStart = new Date(Date.now() - preventDuplicatesWithinMs);
      const dupQuery = {
        userId,
        type,
        createdAt: { $gte: windowStart },
      };
      if (actorId) dupQuery.actorId = actorId;
      if (postId) dupQuery.postId = postId;
      if (courseId) dupQuery.courseId = courseId;
      if (channelFrequency) dupQuery.channelFrequency = channelFrequency;

      const existing = await Notification.findOne(dupQuery);
      if (existing) {
        return existing;
      }
    }

    const notification = await Notification.create({
      userId,
      actorId,
      user: user || 'Someone',
      avatarUrl: avatarUrl || '',
      type,
      title: title || 'Notification',
      action: action || '',
      text: text || `${user} ${action}`,
      postId: postId || null,
      courseId: courseId || null,
      requesterId: requesterId || null,
      channelFrequency: channelFrequency || '',
      unread: true,
      isRead: false,
      time: 'Just now',
      createdAt: new Date(),
    });

    const unreadCount = await Notification.countDocuments({ userId, unread: true });
    const userStr = String(userId);
    const pushPayload = {
      title: title || 'Artube',
      body: text || `${user} ${action}`,
      data: {
        type,
        id: notification._id.toString(),
        userId: userStr,
        ...(postId ? { postId: String(postId) } : {}),
        ...(courseId ? { courseId: String(courseId) } : {}),
        ...(channelFrequency ? { frequency: channelFrequency } : {}),
      },
    };

    setImmediate(() => {
      const msg = JSON.stringify({
        type: 'NEW_NOTIFICATION',
        notification,
        unreadCount,
        timestamp: Date.now(),
      });

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          const clientInfo = wsClients.get(client);
          if (clientInfo && String(clientInfo.userId) === userStr) {
            try {
              client.send(msg);
            } catch (_e) {}
          }
        }
      });

      try {
        io.to(`user:${userStr}`).emit('notification:new', { notification, unreadCount });
      } catch (_e) {}

      sendPushToUser(userId, pushPayload);
    });

    return notification;
  } catch (err) {
    console.warn('[Notification] Dispatch error:', err.message);
    return null;
  }
}

// Bulk notify followers of an artist (e.g. content uploads, live radio)
async function notifyFollowers(artistId, { type, title, action, text, postId = null, courseId = null, channelFrequency = '' }) {
  try {
    const artist = await User.findById(artistId).select('followers displayName username avatarUrl');
    if (!artist || !Array.isArray(artist.followers) || artist.followers.length === 0) {
      return 0;
    }

    const artistName = artist.displayName || artist.username || 'Artist';
    const artistAvatar = artist.avatarUrl || '';

    // Only notify other users who follow this artist
    const recipientIds = artist.followers.filter(
      (fId) => fId && String(fId) !== String(artistId)
    );

    if (recipientIds.length === 0) return 0;

    await Promise.all(
      recipientIds.map((recipientId) =>
        createAndDispatchNotification({
          userId: recipientId,
          actorId: artist._id,
          user: artistName,
          avatarUrl: artistAvatar,
          type,
          title,
          action,
          text,
          postId,
          courseId,
          channelFrequency,
          preventDuplicatesWithinMs: 15 * 60 * 1000, // 15-minute throttle
        }).catch((e) => console.warn('[Notification] Follower notify note:', e.message))
      )
    );

    return recipientIds.length;
  } catch (err) {
    console.warn('[Notification] notifyFollowers error:', err.message);
    return 0;
  }
}

async function onAfterItemCreated(Model, item, creatorUser) {
  try {
    if (!creatorUser || !item) return;
    const authorName = creatorUser.displayName || creatorUser.username || 'Creator';
    const itemVisibility = String(item.visibility || 'public').toLowerCase();

    // Only broadcast for public uploads
    if (itemVisibility !== 'public') return;

    if (Model.modelName === 'Post') {
      const isVideo = Boolean(
        item.mediaType === 'video' ||
        item.bunnyVideoId ||
        item.hlsUrl ||
        item.mp4Url ||
        (item.mediaUrl && String(item.mediaUrl).match(/\.(mp4|mov|m4v|webm)$/i))
      );

      if (isVideo) {
        await notifyFollowers(creatorUser._id, {
          type: 'new_video',
          title: 'New Video in Watch',
          action: `published a new video: "${item.title}"`,
          text: `${authorName} published a new video: "${item.title}"`,
          postId: item._id,
        });
      } else {
        await notifyFollowers(creatorUser._id, {
          type: 'new_content',
          title: 'New Artwork in Watch',
          action: `shared new artwork: "${item.title}"`,
          text: `${authorName} shared new artwork: "${item.title}"`,
          postId: item._id,
        });
      }
    } else if (Model.modelName === 'Course') {
      await notifyFollowers(creatorUser._id, {
        type: 'new_course',
        title: 'New Course in Learn',
        action: `published a new course: "${item.title}"`,
        text: `${authorName} published a new course: "${item.title}"`,
        courseId: item._id,
      });
    }
  } catch (err) {
    console.warn('[Notification] onAfterItemCreated error:', err.message);
  }
}

// Helper function to generate endpoints for a Mongoose Model
function makeCrudEndpoints(routePath, Model, hasUpload = false) {
  // GET all items — supports optional ?visibility=private&author=xyz&userId=abc filters
  // When no userId/creatorId filter is given, defaults to public-only content for safety.
  app.get(routePath, authenticateIfProvided, async (req, res) => {
    try {
      const filter = {};
      const requestedUserId = (req.query.userId || req.query.creatorId || '').trim();
      let requestedUser = null;
      if (requestedUserId) {
        requestedUser = await findUserByIdOrFirebaseUid(requestedUserId);
      }
      const isOwnContent = Boolean(req.user && requestedUser && String(req.user._id) === String(requestedUser._id));

      const andClauses = [];
      if (req.query.visibility) {
        if (req.query.visibility !== 'public' && !isOwnContent && req.user?.role !== 'admin') {
          return res.status(req.user ? 403 : 401).json({ error: 'You can only view your own private content.' });
        }
        filter.visibility = req.query.visibility;
      } else if (!isOwnContent) {
        andClauses.push({
          $or: [
            { visibility: 'public' },
            { visibility: { $exists: false } },
            { visibility: null },
            { visibility: '' },
          ]
        });
      }

      if (req.query.author) filter.author = req.query.author;
      
      if (requestedUserId) {
        if (requestedUser) {
          andClauses.push({
            $or: [
              { userId: requestedUser._id },
              { userId: null, userEmail: requestedUser.email },
              ...(requestedUser.username ? [{ userId: null, author: requestedUser.username }] : [])
            ]
          });
        } else if (requestedUserId.includes('@')) {
          andClauses.push({ userEmail: requestedUserId.toLowerCase() });
        }
      }

      if (andClauses.length > 0) {
        filter.$and = andClauses;
      }

      const { limit, skip } = parsePageLimit(req.query, 50, 100);
      let query = Model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
      if (Model.modelName === 'Post' || Model.modelName === 'Course' || Model.modelName === 'Video') {
        query = query
          .select('-userEmail -artSvg')
          .populate('userId', 'username displayName avatarUrl coverUrl bio isBanned');
      }
      const items = await query;
      const modifiedItems = items.map((doc) => {
        const item = doc.toObject ? doc.toObject() : { ...doc };
        const userObj = item.userId && typeof item.userId === 'object' ? item.userId : null;
        if (userObj) {
          if (userObj.avatarUrl) {
            item.avatarUrl = userObj.avatarUrl;
            item.avatar = userObj.avatarUrl;
            item.instructorAvatar = userObj.avatarUrl;
          }
          if (userObj.displayName || userObj.username) {
            item.author = userObj.displayName || userObj.username;
            item.artist = item.author;
            item.instructor = item.author;
          }
        }
        if (Array.isArray(item.comments)) {
          item.comments = item.comments.map((c) => {
            const cObj = c.toObject ? c.toObject() : { ...c };
            if (cObj.userId && typeof cObj.userId === 'object') {
              if (cObj.userId.avatarUrl) cObj.avatarUrl = cObj.userId.avatarUrl;
              if (cObj.userId.displayName || cObj.userId.username) {
                cObj.author = cObj.userId.displayName || cObj.userId.username;
              }
            }
            return cObj;
          });
        }
        const isVid = Boolean(item.bunnyVideoId || item.mediaType === 'video' || item.type === 'watch' || (item.mediaUrl && item.mediaUrl.includes('b-cdn.net')));
        if (item.bunnyVideoId || (item.mediaUrl && item.mediaUrl.includes('b-cdn.net'))) {
          const guid = item.bunnyVideoId || (item.mediaUrl.match(/vz-[^/]+\.b-cdn\.net\/([^/]+)/) || [])[1];
          if (guid) {
            item.proxyUrl = `/api/bunny/stream/${guid}/play.mp4`;
            item.hlsProxyUrl = `/api/bunny/stream/${guid}/playlist.m3u8`;
            if ((!item.mp4Url || item.mp4Url.includes('play_720p.mp4')) && process.env.BUNNY_STREAM_CDN_HOSTNAME) {
              item.mp4Url = `https://${process.env.BUNNY_STREAM_CDN_HOSTNAME}/${guid}/play.mp4`;
            }
            if ((!item.thumbnailUrl || item.thumbnailUrl.endsWith('.mp4') || item.thumbnailUrl.endsWith('.m3u8')) && process.env.BUNNY_STREAM_CDN_HOSTNAME) {
              item.thumbnailUrl = `https://${process.env.BUNNY_STREAM_CDN_HOSTNAME}/${guid}/thumbnail.jpg`;
              item.image = item.thumbnailUrl;
            }
          }
        }
        item.duration = item.duration || item.videoDuration || '';
        item.videoDuration = item.duration;

        // Normalize difficulty and level
        const rawLvl = item.level || item.difficulty;
        if (rawLvl) {
          const l = String(rawLvl).trim().toLowerCase();
          if (l === 'advanced') { item.level = 'Advanced'; item.difficulty = 'Advanced'; }
          else if (l === 'intermediate') { item.level = 'Intermediate'; item.difficulty = 'Intermediate'; }
          else { item.level = 'Beginner'; item.difficulty = 'Beginner'; }
        }

        if (!item.images || !Array.isArray(item.images) || item.images.length === 0) {
          if (isVid) {
            item.images = (item.mediaUrls || []).filter((u) => {
              if (typeof u !== 'string') return false;
              const lower = u.toLowerCase();
              return !lower.endsWith('.mp4') && !lower.endsWith('.m3u8') && !lower.includes('b-cdn.net/play_') && u !== item.thumbnailUrl && u !== item.image && u !== item.previewUrl;
            });
          } else {
            item.images = (item.mediaUrls && item.mediaUrls.length) ? item.mediaUrls : [item.image || item.thumbnailUrl].filter(Boolean);
          }
        }
        item.relatedImages = item.images;

        if (Model.modelName === 'Course') {
          if (item.rating === 4.8) item.rating = 0;
          if (item.ratingCount === '2.4K') item.ratingCount = 0;
          if (item.enrolled === '12.3K enrolled') item.enrolled = '0 enrolled';
          if (item.duration === '4h 30m' && !item.videoDuration) item.duration = '';
          if (item.author === 'Elena Vasquez' && !item.userId) item.author = '';
          item.progress = 0;
        }
        if (Model.modelName === 'Post') {
          if (item.author === 'Maya Chen' && !item.userId) item.author = '';
          const likedIds = (req.user?.likedPosts || []).map((id) => String(id));
          item.isLiked = likedIds.includes(String(item._id));
        }

        return item;
      });
      res.json(applyViewerContentFilters(modifiedItems, req.user));
    } catch (err) {
      console.error(`Failed to fetch items from ${Model.modelName}:`, err);
      res.status(500).json({ error: `Failed to fetch items from ${Model.modelName}` });
    }
  });

  // GET single item
  app.get(`${routePath}/:id`, authenticateIfProvided, async (req, res) => {
    try {
      let query = Model.findById(req.params.id);
      if (Model.modelName === 'Post' || Model.modelName === 'Course' || Model.modelName === 'Video') {
        query = query.populate('userId', 'username displayName avatarUrl coverUrl bio');
        if (Model.modelName === 'Post') {
          query = query.populate('comments.userId', 'username displayName avatarUrl');
        }
      }
      const doc = await query;
      if (!doc) return res.status(404).json({ error: `Item not found in ${Model.modelName}` });
      const item = doc.toObject ? doc.toObject() : { ...doc };
      const userObj = item.userId && typeof item.userId === 'object' ? item.userId : null;
      if (userObj) {
        if (userObj.avatarUrl) {
          item.avatarUrl = userObj.avatarUrl;
          item.avatar = userObj.avatarUrl;
          item.instructorAvatar = userObj.avatarUrl;
        }
        if (userObj.displayName || userObj.username) {
          item.author = userObj.displayName || userObj.username;
          item.artist = item.author;
          item.instructor = item.author;
        }
      }
      if (Array.isArray(item.comments)) {
        item.comments = item.comments.map((c) => {
          const cObj = c.toObject ? c.toObject() : { ...c };
          if (cObj.userId && typeof cObj.userId === 'object') {
            if (cObj.userId.avatarUrl) cObj.avatarUrl = cObj.userId.avatarUrl;
            if (cObj.userId.displayName || cObj.userId.username) {
              cObj.author = cObj.userId.displayName || cObj.userId.username;
            }
          }
          return cObj;
        });
      }
      if (Model.modelName === 'Post') {
        const likedIds = (req.user?.likedPosts || []).map((id) => String(id));
        item.isLiked = likedIds.includes(String(item._id));
        item.id = item._id;
      }
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch item from ${Model.modelName}` });
    }
  });

  // POST create item — authentication required
  const middleware = hasUpload ? upload.fields([
    { name: 'file', maxCount: 21 },
    { name: 'extraFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 },
    { name: 'trailerFile', maxCount: 1 },
    { name: 'lessonVideos', maxCount: 30 }
  ]) : (req, res, next) => next();
  app.post(routePath, authenticateUser, middleware, async (req, res) => {
    try {
      const data = {
        ...req.body,
        visibility: req.body.visibility || 'public',
        userId: req.user._id,
        userEmail: req.user.email,
        author: req.user.displayName || req.user.username,
      };
      const resolvedAvatar = req.user.avatarUrl || req.body.avatarUrl || req.body.avatar || '';
      if (resolvedAvatar) {
        data.avatarUrl = resolvedAvatar;
        data.avatar = resolvedAvatar;
        data.instructorAvatar = resolvedAvatar;
      }

      // An authenticated account ID is authoritative; client-supplied ownership
      // fields are never used to assign the new record.

      // Sanitize empty or invalid ObjectId string values to prevent Mongoose CastErrors
      for (const key in data) {
        const schemaField = Model.schema.paths[key];
        if (schemaField && (schemaField.instance === 'ObjectID' || schemaField.instance === 'ObjectId')) {
          if (!data[key] || data[key] === '' || !mongoose.Types.ObjectId.isValid(data[key])) {
            data[key] = null;
          }
        }
      }
      
      // Duration handling for video
      if (data.duration || data.videoDuration) {
        data.duration = String(data.duration || data.videoDuration || '').trim();
        data.videoDuration = data.duration;
      }

      // Normalize course difficulty / level
      const rawPostLvl = data.level || data.difficulty;
      if (rawPostLvl) {
        const l = String(rawPostLvl).trim().toLowerCase();
        if (l === 'advanced') { data.level = 'Advanced'; data.difficulty = 'Advanced'; }
        else if (l === 'intermediate') { data.level = 'Intermediate'; data.difficulty = 'Intermediate'; }
        else { data.level = 'Beginner'; data.difficulty = 'Beginner'; }
      }

      // If files uploaded, upload to Bunny Stream (for videos) or Cloudinary (for images)
      if (req.files) {
        if (req.files['file'] && req.files['file'].length > 0) {
          const imageUrls = [];
          let hasVideo = false;
          for (const file of req.files['file']) {
            if (file.size > 0) {
              if (isVideoFile(file)) {
                hasVideo = true;
                const bRes = await uploadVideoToBunnyStream(file, data.title || file.originalname);
                data.mediaUrl = bRes.mediaUrl;
                data.hlsUrl = bRes.hlsUrl;
                data.mp4Url = bRes.mp4Url;
                data.previewUrl = bRes.previewUrl;
                data.embedUrl = bRes.embedUrl;
                data.bunnyVideoId = bRes.guid;
                data.bunnyLibraryId = bRes.libraryId;
                data.proxyUrl = `/api/bunny/stream/${bRes.guid}/play.mp4`;
                if (!data.thumbnailUrl) {
                  data.thumbnailUrl = bRes.thumbnailUrl;
                  data.image = bRes.thumbnailUrl;
                }
                data.mediaType = 'video';
              } else {
                const url = await uploadToCloudinary(file);
                imageUrls.push(url);
              }
            }
          }
          data.images = imageUrls;
          data.relatedImages = imageUrls;
          if (hasVideo) {
            data.mediaType = imageUrls.length > 0 ? 'mixed' : 'video';
            data.mediaUrls = imageUrls; // Only additional images in mediaUrls so thumbnail isn't duplicated
          } else {
            data.mediaUrls = imageUrls;
            data.mediaUrl = imageUrls[0] || '';
            if (!data.thumbnailUrl) {
              data.thumbnailUrl = imageUrls[0] || '';
              data.image = imageUrls[0] || '';
            }
            data.mediaType = 'image';
            data.duration = '';
            data.videoDuration = '';
          }
        }
        if (req.files['extraFile'] && req.files['extraFile'][0] && req.files['extraFile'][0].size > 0) {
          const extraFile = req.files['extraFile'][0];
          if (isVideoFile(extraFile)) {
            const bRes = await uploadVideoToBunnyStream(extraFile, (data.title || '') + ' Extra');
            data.extraMediaUrl = bRes.mediaUrl;
            data.extraMediaType = 'video';
          } else {
            const extraMediaUrl = await uploadToCloudinary(extraFile);
            data.extraMediaUrl = extraMediaUrl;
            data.extraMediaType = 'image';
          }
        }
        if (req.files['thumbnailFile'] && req.files['thumbnailFile'][0] && req.files['thumbnailFile'][0].size > 0) {
          const thumbnailFile = req.files['thumbnailFile'][0];
          const thumbnailUrl = await uploadToCloudinary(thumbnailFile);
          data.thumbnailUrl = thumbnailUrl;
          data.image = thumbnailUrl;
          data.bannerUrl = data.bannerUrl || thumbnailUrl;
          data.thumbnailMediaType = isVideoFile(thumbnailFile) ? 'video' : 'image';
        }
        if (req.files['trailerFile'] && req.files['trailerFile'][0] && req.files['trailerFile'][0].size > 0) {
          const trailerFile = req.files['trailerFile'][0];
          if (isVideoFile(trailerFile)) {
            const bRes = await uploadVideoToBunnyStream(trailerFile, (data.title || '') + ' Trailer');
            data.mediaUrl = bRes.mediaUrl;
            data.hlsUrl = bRes.hlsUrl;
            data.mp4Url = bRes.mp4Url;
            data.bunnyVideoId = bRes.guid;
            data.mediaType = 'video';
          } else {
            const trailerUrl = await uploadToCloudinary(trailerFile);
            data.mediaUrl = trailerUrl;
            data.mediaType = 'video';
          }
        }
      }

      // Propagate image/bannerUrl/mediaUrl aliases
      if (data.thumbnailUrl && !data.image) data.image = data.thumbnailUrl;
      if (data.mediaUrl && !data.image) data.image = data.mediaUrl;
      if (data.mediaUrl && !data.bannerUrl) data.bannerUrl = data.mediaUrl;
      if (data.thumbnailUrl && !data.bannerUrl) data.bannerUrl = data.thumbnailUrl;
      if (data.image && !data.thumbnailUrl) data.thumbnailUrl = data.image;

      for (const key of ['mediaUrl', 'thumbnailUrl', 'image', 'coverUrl', 'bannerUrl', 'extraMediaUrl']) {
        data[key] = makeMediaUrlPublic(req, data[key]);
      }
      if (Array.isArray(data.mediaUrls)) {
        data.mediaUrls = data.mediaUrls.map((url) => makeMediaUrlPublic(req, url));
      }
      if (Array.isArray(data.images)) {
        data.images = data.images.map((url) => makeMediaUrlPublic(req, url));
      }

      // Safely parse JSON strings for complex array fields
      if (typeof data.lessons === 'string') {
        try {
          data.lessons = JSON.parse(data.lessons);
        } catch(e) {
          data.lessons = data.lessons.split('\n').filter(Boolean).map((t, i) => ({
            id: String(i + 1),
            title: t.trim(),
            duration: '10:00',
            mediaUrl: data.mediaUrl || '',
            mediaType: 'video',
            isCompleted: false
          }));
        }
      }

      // Assign uploaded lesson videos to lessons array
      if (req.files && req.files['lessonVideos'] && req.files['lessonVideos'].length > 0) {
        const uploadedLessonUrls = [];
        for (const lFile of req.files['lessonVideos']) {
          if (lFile.size > 0) {
            if (isVideoFile(lFile)) {
              const bRes = await uploadVideoToBunnyStream(lFile, 'Course Lesson');
              uploadedLessonUrls.push(bRes.mediaUrl);
            } else {
              const lUrl = await uploadToCloudinary(lFile);
              uploadedLessonUrls.push(lUrl);
            }
          }
        }
        if (Array.isArray(data.lessons)) {
          data.lessons.forEach((les, idx) => {
            if (uploadedLessonUrls[idx]) {
              les.mediaUrl = uploadedLessonUrls[idx];
            }
          });
        }
      }
      if (typeof data.whatYouLearn === 'string') {
        try {
          data.whatYouLearn = JSON.parse(data.whatYouLearn);
        } catch(e) {
          data.whatYouLearn = data.whatYouLearn.split('\n').map(s => s.trim()).filter(Boolean);
        }
      }
      if (typeof data.learnItems === 'string') {
        try {
          data.learnItems = JSON.parse(data.learnItems);
        } catch(e) {
          data.learnItems = data.learnItems.split('\n').map(s => s.trim()).filter(Boolean);
        }
      }
      if (Array.isArray(data.whatYouLearn) && !data.learnItems) {
        data.learnItems = data.whatYouLearn;
      } else if (Array.isArray(data.learnItems) && !data.whatYouLearn) {
        data.whatYouLearn = data.learnItems;
      }
      if (typeof data.tags === 'string') {
        try {
          data.tags = JSON.parse(data.tags);
        } catch(e) {
          data.tags = data.tags.split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      const item = new Model(data);
      await item.save();
      await onAfterItemCreated(Model, item, req.user);
      res.status(201).json(item);
    } catch (err) {
      console.error(`Error saving to ${Model.modelName}:`, err);
      res.status(500).json({ error: `Failed to create item in ${Model.modelName}` });
    }
  });

  // PUT update item — authentication and permanent-ID ownership are required.
  app.put(`${routePath}/:id`, authenticateUser, middleware, async (req, res) => {
    try {
      const existing = await Model.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: `Item not found in ${Model.modelName}` });
      const isOwner = existing.userId
        ? String(existing.userId) === String(req.user._id)
        : Boolean(existing.userEmail && existing.userEmail.toLowerCase() === (req.user.email || '').toLowerCase());
      if (!isOwner && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only edit your own content.' });
      }

      const data = { ...req.body };
      // Keep ownership attached to the permanent account ID on every edit.
      delete data.userId;
      delete data.userEmail;
      
      // Sanitize empty string values for ObjectId fields to prevent casting errors
      for (const key in data) {
        const schemaField = Model.schema.paths[key];
        if (schemaField && (schemaField.instance === 'ObjectID' || schemaField.instance === 'ObjectId') && data[key] === '') {
          data[key] = null;
        }
      }

      
      // Duration handling for video
      if (data.duration || data.videoDuration) {
        data.duration = String(data.duration || data.videoDuration || '').trim();
        data.videoDuration = data.duration;
      }

      // Normalize course difficulty / level
      const rawPutLvl = data.level || data.difficulty;
      if (rawPutLvl) {
        const l = String(rawPutLvl).trim().toLowerCase();
        if (l === 'advanced') { data.level = 'Advanced'; data.difficulty = 'Advanced'; }
        else if (l === 'intermediate') { data.level = 'Intermediate'; data.difficulty = 'Intermediate'; }
        else { data.level = 'Beginner'; data.difficulty = 'Beginner'; }
      }

      // If files uploaded, upload to Bunny Stream (for videos) or Cloudinary (for images)
      if (req.files) {
        if (req.files['file'] && req.files['file'].length > 0) {
          const imageUrls = [];
          let hasVideo = false;
          for (const file of req.files['file']) {
            if (file.size > 0) {
              if (isVideoFile(file)) {
                hasVideo = true;
                const bRes = await uploadVideoToBunnyStream(file, data.title || file.originalname);
                data.mediaUrl = bRes.mediaUrl;
                data.hlsUrl = bRes.hlsUrl;
                data.mp4Url = bRes.mp4Url;
                data.previewUrl = bRes.previewUrl;
                data.embedUrl = bRes.embedUrl;
                data.bunnyVideoId = bRes.guid;
                data.bunnyLibraryId = bRes.libraryId;
                data.proxyUrl = `/api/bunny/stream/${bRes.guid}/play.mp4`;
                if (!data.thumbnailUrl) {
                  data.thumbnailUrl = bRes.thumbnailUrl;
                  data.image = bRes.thumbnailUrl;
                }
                data.mediaType = 'video';
              } else {
                const url = await uploadToCloudinary(file);
                imageUrls.push(url);
              }
            }
          }
          data.images = imageUrls;
          data.relatedImages = imageUrls;
          if (hasVideo) {
            data.mediaType = imageUrls.length > 0 ? 'mixed' : 'video';
            data.mediaUrls = imageUrls; // Only additional images in mediaUrls so thumbnail isn't duplicated
          } else {
            data.mediaUrls = imageUrls;
            data.mediaUrl = imageUrls[0] || '';
            if (!data.thumbnailUrl) {
              data.thumbnailUrl = imageUrls[0] || '';
              data.image = imageUrls[0] || '';
            }
            data.mediaType = 'image';
            data.duration = '';
            data.videoDuration = '';
          }
        }
        if (req.files['extraFile'] && req.files['extraFile'][0] && req.files['extraFile'][0].size > 0) {
          const extraFile = req.files['extraFile'][0];
          if (isVideoFile(extraFile)) {
            const bRes = await uploadVideoToBunnyStream(extraFile, (data.title || '') + ' Extra');
            data.extraMediaUrl = bRes.mediaUrl;
            data.extraMediaType = 'video';
          } else {
            const extraMediaUrl = await uploadToCloudinary(extraFile);
            data.extraMediaUrl = extraMediaUrl;
            data.extraMediaType = 'image';
          }
        }
        if (req.files['thumbnailFile'] && req.files['thumbnailFile'][0] && req.files['thumbnailFile'][0].size > 0) {
          const thumbnailFile = req.files['thumbnailFile'][0];
          const thumbnailUrl = await uploadToCloudinary(thumbnailFile);
          data.thumbnailUrl = thumbnailUrl;
          data.image = thumbnailUrl;
          data.bannerUrl = data.bannerUrl || thumbnailUrl;
          data.thumbnailMediaType = isVideoFile(thumbnailFile) ? 'video' : 'image';
        }
        if (req.files['trailerFile'] && req.files['trailerFile'][0] && req.files['trailerFile'][0].size > 0) {
          const trailerFile = req.files['trailerFile'][0];
          if (isVideoFile(trailerFile)) {
            const bRes = await uploadVideoToBunnyStream(trailerFile, (data.title || '') + ' Trailer');
            data.mediaUrl = bRes.mediaUrl;
            data.hlsUrl = bRes.hlsUrl;
            data.mp4Url = bRes.mp4Url;
            data.bunnyVideoId = bRes.guid;
            data.mediaType = 'video';
          } else {
            const trailerUrl = await uploadToCloudinary(trailerFile);
            data.mediaUrl = trailerUrl;
            data.mediaType = 'video';
          }
        }
      }

      if (data.thumbnailUrl && !data.image) data.image = data.thumbnailUrl;
      if (data.mediaUrl && !data.image) data.image = data.mediaUrl;
      if (data.mediaUrl && !data.bannerUrl) data.bannerUrl = data.mediaUrl;
      if (data.thumbnailUrl && !data.bannerUrl) data.bannerUrl = data.thumbnailUrl;
      if (data.image && !data.thumbnailUrl) data.thumbnailUrl = data.image;

      for (const key of ['mediaUrl', 'thumbnailUrl', 'image', 'coverUrl', 'bannerUrl', 'extraMediaUrl']) {
        data[key] = makeMediaUrlPublic(req, data[key]);
      }
      if (Array.isArray(data.mediaUrls)) {
        data.mediaUrls = data.mediaUrls.map((url) => makeMediaUrlPublic(req, url));
      }
      if (Array.isArray(data.images)) {
        data.images = data.images.map((url) => makeMediaUrlPublic(req, url));
      }

      if (typeof data.lessons === 'string') {
        try {
          data.lessons = JSON.parse(data.lessons);
        } catch(e) {
          data.lessons = data.lessons.split('\n').filter(Boolean).map((t, i) => ({
            id: String(i + 1),
            title: t.trim(),
            duration: '10:00',
            mediaUrl: data.mediaUrl || '',
            mediaType: 'video',
            isCompleted: false
          }));
        }
      }

      // Assign uploaded lesson videos to lessons array
      if (req.files && req.files['lessonVideos'] && req.files['lessonVideos'].length > 0) {
        const uploadedLessonUrls = [];
        for (const lFile of req.files['lessonVideos']) {
          if (lFile.size > 0) {
            if (isVideoFile(lFile)) {
              const bRes = await uploadVideoToBunnyStream(lFile, 'Course Lesson');
              uploadedLessonUrls.push(bRes.mediaUrl);
            } else {
              const lUrl = await uploadToCloudinary(lFile);
              uploadedLessonUrls.push(lUrl);
            }
          }
        }
        if (Array.isArray(data.lessons)) {
          data.lessons.forEach((les, idx) => {
            if (uploadedLessonUrls[idx]) {
              les.mediaUrl = uploadedLessonUrls[idx];
            }
          });
        }
      }
      if (typeof data.whatYouLearn === 'string') {
        try {
          data.whatYouLearn = JSON.parse(data.whatYouLearn);
        } catch(e) {
          data.whatYouLearn = data.whatYouLearn.split('\n').map(s => s.trim()).filter(Boolean);
        }
      }
      if (typeof data.learnItems === 'string') {
        try {
          data.learnItems = JSON.parse(data.learnItems);
        } catch(e) {
          data.learnItems = data.learnItems.split('\n').map(s => s.trim()).filter(Boolean);
        }
      }
      if (Array.isArray(data.whatYouLearn) && !data.learnItems) {
        data.learnItems = data.whatYouLearn;
      } else if (Array.isArray(data.learnItems) && !data.whatYouLearn) {
        data.whatYouLearn = data.learnItems;
      }
      if (typeof data.tags === 'string') {
        try {
          data.tags = JSON.parse(data.tags);
        } catch(e) {
          data.tags = data.tags.split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      const item = await Model.findByIdAndUpdate(req.params.id, data, { new: true });
      if (!item) {
        return res.status(404).json({ error: `Item not found in ${Model.modelName}` });
      }
      res.json(item);
    } catch (err) {
      res.status(500).json({ error: `Failed to update item in ${Model.modelName}` });
    }
  });

  // DELETE item
  app.delete(`${routePath}/:id`, (req, res, next) => authenticateUser(req, res, next), async (req, res) => {
    try {
      const item = await Model.findById(req.params.id);
      if (!item) {
        return res.status(404).json({ error: `Item not found in ${Model.modelName}` });
      }
      const ownsItem = item.userId
        ? String(item.userId) === String(req.user._id)
        : Boolean(item.userEmail && item.userEmail.toLowerCase() === String(req.user.email || '').toLowerCase());
      if (!ownsItem && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only delete your own content.' });
      }

      await item.deleteOne();
      if (item.bunnyVideoId) {
        deleteVideoFromBunnyStream(item.bunnyVideoId);
      }
      res.json({ success: true, message: 'Deleted successfully', item });
    } catch (err) {
      res.status(500).json({ error: `Failed to delete item from ${Model.modelName}` });
    }
  });
}

// Generate CRUD routes
makeCrudEndpoints('/api/posts', Post, true);
makeCrudEndpoints('/api/artists', Artist, false);
makeCrudEndpoints('/api/videos', Video, true);
makeCrudEndpoints('/api/courses', Course, true);

// --- COURSE ENROLLMENT ---
app.post('/api/courses/:id/enroll', authenticateUser, async (req, res) => {
  try {
    const courseId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(courseId)) {
      return res.status(400).json({ error: 'Invalid course id.' });
    }

    const courseObjectId = new mongoose.Types.ObjectId(courseId);
    const userId = req.user._id;

    const course = await Course.findById(courseObjectId).select('_id enrolledStudents enrolledCount').lean();
    if (!course) {
      return res.status(404).json({ error: 'Course not found.' });
    }

    await User.updateOne(
      { _id: userId },
      { $addToSet: { enrolledCourses: courseObjectId } }
    );

    const alreadyEnrolled = Array.isArray(course.enrolledStudents)
      && course.enrolledStudents.some((id) => String(id) === String(userId));

    if (!alreadyEnrolled) {
      const nextCount = Number(course.enrolledCount || 0) + 1;
      await Course.updateOne(
        { _id: courseObjectId, enrolledStudents: { $ne: userId } },
        {
          $addToSet: { enrolledStudents: userId },
          $inc: { enrolledCount: 1 },
          $set: { enrolled: `${nextCount} enrolled` },
        }
      );
    }

    res.json({
      success: true,
      alreadyEnrolled: Boolean(alreadyEnrolled),
      message: alreadyEnrolled ? 'Already enrolled in this course.' : 'Enrolled in course successfully.',
    });
  } catch (err) {
    console.error('Error enrolling in course:', err);
    res.status(500).json({ error: 'Failed to enroll in course.' });
  }
});

app.get('/api/users/me/enrolled-courses', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate({
      path: 'enrolledCourses',
      populate: { path: 'userId', select: 'username displayName avatarUrl' },
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user.enrolledCourses || []);
  } catch (err) {
    console.error('Error fetching enrolled courses:', err);
    res.status(500).json({ error: 'Failed to fetch enrolled courses.' });
  }
});
// --- PUSH NOTIFICATIONS (EXPO PUSH API) REGISTRATION ---

app.post('/api/users/push-token', authenticateUser, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Push token is required.' });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!Array.isArray(user.pushTokens)) user.pushTokens = [];
    const existingIndex = user.pushTokens.findIndex((t) => t.token === token);
    if (existingIndex >= 0) {
      user.pushTokens[existingIndex].updatedAt = new Date();
    } else {
      user.pushTokens.push({ token, platform: platform || 'expo', updatedAt: new Date() });
    }
    await user.save();
    res.json({ success: true, message: 'Push token registered successfully.' });
  } catch (err) {
    console.error('Failed to register push token:', err);
    res.status(500).json({ error: 'Failed to register push token.' });
  }
});

app.delete('/api/users/push-token', authenticateUser, async (req, res) => {
  try {
    const { token } = req.body;
    const user = await User.findById(req.user._id);
    if (user && token && Array.isArray(user.pushTokens)) {
      user.pushTokens = user.pushTokens.filter((t) => t.token !== token);
      await user.save();
    }
    res.json({ success: true, message: 'Push token removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove push token.' });
  }
});

// ==========================================
// --- NOTIFICATION API ENDPOINTS ---
// ==========================================

// GET /api/notifications - Retrieve authenticated user's notifications with pagination
app.get('/api/notifications', authenticateUser, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId: req.user._id }),
      Notification.countDocuments({ userId: req.user._id, unread: true }),
    ]);

    res.json({
      notifications,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      unreadCount,
    });
  } catch (err) {
    console.error('Failed to fetch notifications:', err);
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
});

// GET /api/notifications/unread-count - Unread count for badge
app.get('/api/notifications/unread-count', authenticateUser, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user._id, unread: true });
    res.json({ count, unreadCount: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unread notification count.' });
  }
});

// PATCH / PUT /api/notifications/:id/read - Mark specific notification as read
const handleMarkNotificationRead = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid notification ID.' });
    }
    const notif = await Notification.findOne({ _id: req.params.id, userId: req.user._id });
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found.' });
    }
    notif.unread = false;
    notif.isRead = true;
    await notif.save();

    const unreadCount = await Notification.countDocuments({ userId: req.user._id, unread: true });
    res.json({ success: true, notification: notif, unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
};
app.patch('/api/notifications/:id/read', authenticateUser, handleMarkNotificationRead);
app.put('/api/notifications/:id/read', authenticateUser, handleMarkNotificationRead);
app.put('/api/notifications/:id', authenticateUser, handleMarkNotificationRead);

// PATCH / PUT /api/notifications/read-all - Mark all user notifications as read
const handleMarkAllNotificationsRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, unread: true },
      { $set: { unread: false, isRead: true } }
    );
    res.json({ success: true, count: result.modifiedCount, unreadCount: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all notifications as read.' });
  }
};
app.patch('/api/notifications/read-all', authenticateUser, handleMarkAllNotificationsRead);
app.put('/api/notifications/read-all', authenticateUser, handleMarkAllNotificationsRead);

// DELETE /api/notifications/:id - Delete single notification belonging to user
app.delete('/api/notifications/:id', authenticateUser, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid notification ID.' });
    }
    const deleted = await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!deleted) {
      return res.status(404).json({ error: 'Notification not found.' });
    }
    const unreadCount = await Notification.countDocuments({ userId: req.user._id, unread: true });
    res.json({ success: true, message: 'Notification deleted.', unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete notification.' });
  }
});

// DELETE /api/notifications - Clear all notifications for authenticated user ONLY
app.delete('/api/notifications', authenticateUser, async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user._id });
    res.json({ success: true, message: 'All notifications cleared.', unreadCount: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear notifications.' });
  }
});
makeCrudEndpoints('/api/communities', Community, true);
makeCrudEndpoints('/api/challenges', Challenge, true);
// --- BUNNY.NET STREAM VIDEOS ENDPOINT ---
app.get('/api/bunny/videos', async (req, res) => {
  try {
    const { libraryId, apiKey, cdnHostname } = getBunnyStreamConfig({ readOnly: true });
    
    const page = req.query.page || 1;
    const perPage = req.query.perPage || 100;
    
    const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos?page=${page}&itemsPerPage=${perPage}`, {
      method: 'GET',
      headers: {
        'AccessKey': apiKey,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch videos from Bunny Stream' });
    }
    
    const data = await response.json();
    if (data.items && Array.isArray(data.items)) {
      data.items = data.items.map(v => ({
        ...v,
        hlsUrl: `https://${cdnHostname}/${v.guid}/playlist.m3u8`,
        mp4Url: `https://${cdnHostname}/${v.guid}/play_720p.mp4`,
        thumbnailUrl: `https://${cdnHostname}/${v.guid}/thumbnail.jpg`,
        previewUrl: `https://${cdnHostname}/${v.guid}/preview.webp`,
        embedUrl: `https://iframe.mediadelivery.net/embed/${libraryId}/${v.guid}`
      }));
    }
    
    res.json(data);
  } catch (err) {
    console.error('Error fetching Bunny videos:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- BUNNY STREAM REVERSE PROXY (Bypasses referer restrictions for any player) ---
app.get('/api/bunny/stream/:guid/*', async (req, res) => {
  try {
    const guid = req.params.guid;
    const subpath = req.params[0] || 'playlist.m3u8';
    const { cdnHostname } = getBunnyStreamConfig({ readOnly: true });
    const targetUrl = `https://${cdnHostname}/${guid}/${subpath}`;

    const fetchHeaders = {
      'Referer': 'https://iframe.mediadelivery.net/'
    };
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    let proxyRes = await fetch(targetUrl, {
      method: 'GET',
      headers: fetchHeaders
    });

    // Auto-fallback if requested resolution (e.g. play.mp4 or 720p) is not available
    if ((proxyRes.status === 404 || subpath === 'play.mp4') && subpath.includes('mp4')) {
      for (const resFallback of ['play_720p.mp4', 'play_480p.mp4', 'play_360p.mp4', 'play_240p.mp4']) {
        const fallbackUrl = `https://${cdnHostname}/${guid}/${resFallback}`;
        const fbRes = await fetch(fallbackUrl, { method: 'GET', headers: fetchHeaders });
        if (fbRes.ok) {
          proxyRes = fbRes;
          break;
        }
      }
    }

    res.status(proxyRes.status);
    proxyRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(lower)) {
        res.setHeader(key, val);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (proxyRes.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(proxyRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Stream proxy error:', err);
    res.status(500).end();
  }
});

// Proxy for Bunny video thumbnail
app.get('/api/bunny/thumbnail/:guid', async (req, res) => {
  try {
    const guid = req.params.guid;
    const { cdnHostname } = getBunnyStreamConfig({ readOnly: true });
    const targetUrl = `https://${cdnHostname}/${guid}/thumbnail.jpg`;

    const proxyRes = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'Referer': 'https://iframe.mediadelivery.net/' }
    });

    res.status(proxyRes.status);
    res.setHeader('Content-Type', proxyRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (proxyRes.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(proxyRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.status(500).end();
  }
});

// --- UNIFIED SEARCH ENDPOINT ---
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ posts: [], videos: [], artists: [], courses: [], communities: [], challenges: [] });
    }
    const regex = new RegExp(escapeRegex(q).slice(0, 80), 'i');
    const [posts, videos, artists, courses, communities, challenges, users] = await Promise.all([
      Post.find({ $or: [{ title: regex }, { author: regex }, { tag: regex }] }).select('-userEmail -artSvg').limit(20).lean(),
      Video.find({ $or: [{ title: regex }, { author: regex }] }).limit(20).lean(),
      Artist.find({ $or: [{ name: regex }, { bio: regex }] }).limit(20).lean(),
      Course.find({ $or: [{ title: regex }, { author: regex }] }).select('-userEmail').limit(20).lean(),
      Community.find({ $or: [{ name: regex }, { description: regex }] }).limit(10).lean(),
      Challenge.find({ $or: [{ title: regex }, { description: regex }] }).limit(10).lean(),
      User.find({ $or: [{ displayName: regex }, { username: regex }, { bio: regex }] }).select('displayName username avatarUrl bio followers').limit(20).lean()
    ]);
    const artistNames = new Set(artists.map(a => (a.name || '').toLowerCase()));
    const mappedUsers = (users || [])
      .filter(u => !artistNames.has((u.displayName || u.username || '').toLowerCase()))
      .map(u => ({
        _id: u._id,
        id: u._id,
        name: u.displayName || u.username,
        username: u.username,
        avatar: u.avatarUrl,
        bio: u.bio || 'Digital Creator',
        followers: (u.followers || []).length
      }));
    res.json({ posts, videos, artists: [...artists, ...mappedUsers], courses, communities, challenges });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- COMMUNITY INTERACTION ENDPOINTS ---
app.post('/api/communities/:id/join', authenticateUser, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Community not found' });
    const isMember = community.members.some((memberId) => String(memberId) === String(req.user._id));
    if (!isMember) {
      community.members.addToSet(req.user._id);
      community.membersCount = community.members.length;
      await community.save();
    }
    res.json({ isMember: true, membersCount: community.membersCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join community' });
  }
});

app.delete('/api/communities/:id/leave', authenticateUser, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) return res.status(404).json({ error: 'Community not found' });
    const isMember = community.members.some((memberId) => String(memberId) === String(req.user._id));
    if (isMember) {
      community.members.pull(req.user._id);
      community.membersCount = community.members.length;
      await community.save();
    }
    res.json({ isMember: false, membersCount: community.membersCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave community' });
  }
});

// --- CHALLENGE INTERACTION ENDPOINTS ---
app.post('/api/challenges/:id/join', authenticateUser, async (req, res) => {
  try {
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    const isParticipant = challenge.participants.some((participantId) => String(participantId) === String(req.user._id));
    if (!isParticipant) {
      challenge.participants.addToSet(req.user._id);
      challenge.participantsCount = challenge.participants.length;
      await challenge.save();
    }
    res.json({ isJoined: true, participantsCount: challenge.participantsCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join challenge' });
  }
});

app.post('/api/challenges/:id/submit', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ error: 'A valid post is required.' });
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.userId && String(post.userId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'You can only submit your own post.' });
    }
    challenge.submissions.push({
      userId: String(req.user._id),
      postId,
      author: req.user.displayName || req.user.username
    });
    await challenge.save();
    res.json({ success: true, submissionCount: challenge.submissions.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit to challenge' });
  }
});

app.get('/api/challenges/:id/leaderboard', async (req, res) => {
  try {
    const challenge = await Challenge.findById(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    const postIds = challenge.submissions.map(s => s.postId).filter(Boolean);
    const posts = await Post.find({ _id: { $in: postIds } }).sort({ likesCount: -1, viewsCount: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// --- BACKGROUND SCHEDULED POST PUBLISHER ---
const scheduledPostPublisher = setInterval(async () => {
  try {
    const now = new Date();
    const scheduledPosts = await Post.find({
      visibility: 'scheduled',
      scheduledTime: { $lte: now }
    });

    for (const post of scheduledPosts) {
      post.visibility = 'public';
      await post.save();
      console.log(`[Scheduled Post Publisher] Auto-published post: "${post.title}" (ID: ${post._id})`);
    }
  } catch (err) {
    console.error('Error in scheduled post publisher loop:', err);
  }
}, 30000);
scheduledPostPublisher.unref?.();

// View count endpoint – increments viewsCount every time someone opens an artwork
app.post('/api/posts/:id/view', authenticateIfProvided, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('userId viewsCount views').lean();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const ownerId = post.userId ? String(post.userId) : '';
    const viewerId = req.user?._id ? String(req.user._id) : '';
    if (ownerId && viewerId && ownerId === viewerId) {
      return res.json({ viewsCount: post.viewsCount || 0, views: post.views || '0 views' });
    }
    const updated = await Post.findByIdAndUpdate(
      post._id,
      { $inc: { viewsCount: 1 } },
      { new: true, projection: { viewsCount: 1 } }
    ).lean();
    const viewsCount = updated?.viewsCount || (post.viewsCount || 0) + 1;
    res.json({ viewsCount, views: `${viewsCount} views` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to increment view count' });
  }
});

// GET single post by ID – used by the client for live count polling
app.get('/api/posts/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('-userEmail');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const obj = post.toObject();
    obj.id = obj._id;
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// Specific extra endpoints for Post likes & comments
app.post('/api/posts/:id/like', authenticateUser, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: 'User session is no longer valid.' });
    const alreadyLiked = user.likedPosts.some((likedPostId) => String(likedPostId) === String(post._id));
    if (alreadyLiked) {
      user.likedPosts.pull(post._id);
      post.likesCount = Math.max(0, Number(post.likesCount || 0) - 1);
    } else {
      user.likedPosts.addToSet(post._id);
      post.likesCount = Number(post.likesCount || 0) + 1;
    }
    await user.save();
    await post.save();
    post.isLiked = !alreadyLiked;
    if (!alreadyLiked && post.userId) {
      createAndDispatchNotification({
        userId: post.userId,
        actorId: user._id,
        user: user.displayName || user.username || 'Someone',
        action: `liked your artwork "${post.title}"`,
        text: `${user.displayName || user.username || 'Someone'} liked your artwork "${post.title}"`,
        avatarUrl: user.avatarUrl || '',
        type: 'like',
        title: 'New Like',
        postId: post._id,
        preventDuplicatesWithinMs: 60 * 60 * 1000,
      }).catch(() => {});
    }
    broadcast('LIKE_UPDATE', { postId: post._id, likesCount: post.likesCount });
    res.json({ isLiked: !alreadyLiked, likesCount: post.likesCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

app.post('/api/posts/:id/comment', authenticateUser, async (req, res) => {
  try {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Text is required' });
    
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    
    const author = req.user.displayName || req.user.username || req.body.author || 'Anonymous';
    const avatarUrl = req.user.avatarUrl || req.body.avatarUrl || '';
    const newComment = {
      userId: req.user._id,
      author,
      avatarUrl,
      text: text.trim(),
      createdAt: new Date()
    };
    post.comments.push(newComment);
    await post.save();

    // Persist real notification and dispatch to recipient only
    if (post.userId) {
      createAndDispatchNotification({
        userId: post.userId,
        actorId: req.user._id,
        user: author || 'Someone',
        action: `commented on your post "${post.title}"`,
        text: `${author || 'Someone'} commented on "${post.title}": "${text.length > 40 ? text.slice(0, 37) + '...' : text}"`,
        avatarUrl: req.user.avatarUrl || '',
        type: 'comment',
        title: 'New Comment',
        postId: post._id,
      }).catch(() => {});
    }

    // Broadcast comment update for live UI
    broadcast('NEW_COMMENT', { postId: post._id, comment: newComment, postTitle: post.title });

    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

const findOwnedComment = (post, commentId, user) => {
  const comment = post?.comments?.id?.(commentId) || post?.comments?.find((item) => String(item._id) === String(commentId));
  if (!comment) return { error: 'Comment not found', status: 404 };
  const ownerId = String(comment.userId?._id || comment.userId || '');
  if (ownerId && ownerId !== String(user._id) && user.role !== 'admin') {
    return { error: 'You can only change your own comment.', status: 403 };
  }
  if (!ownerId && user.role !== 'admin') {
    const author = String(comment.author || '').replace(/^@/, '').toLowerCase();
    const mine = String(user.username || '').replace(/^@/, '').toLowerCase();
    if (!mine || mine !== author) {
      return { error: 'You can only change your own comment.', status: 403 };
    }
  }
  return { comment };
};

app.put('/api/posts/:id/comments/:commentId', authenticateUser, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const found = findOwnedComment(post, req.params.commentId, req.user);
    if (found.error) return res.status(found.status).json({ error: found.error });
    found.comment.text = text;
    found.comment.editedAt = new Date();
    await post.save();
    broadcast('COMMENT_UPDATE', { postId: post._id, comment: found.comment });
    res.json({ ok: true, comment: found.comment, comments: post.comments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

app.delete('/api/posts/:id/comments/:commentId', authenticateUser, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const found = findOwnedComment(post, req.params.commentId, req.user);
    if (found.error) return res.status(found.status).json({ error: found.error });
    post.comments.pull(found.comment._id);
    await post.save();
    broadcast('COMMENT_DELETE', { postId: post._id, commentId: req.params.commentId });
    res.json({ ok: true, comments: post.comments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// --- USER PROFILE ENDPOINTS ---

// Firebase Sync - exchange a verified Firebase ID token for a backend JWT.
app.post('/api/users/firebase-sync', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);

    let decodedToken = null;
    let firebaseUid = null;
    let email = null;

    if (firebaseAdmin) {
      if (!bearerMatch) {
        return res.status(401).json({ error: 'Authorization header with Firebase ID token is required.' });
      }
      try {
        decodedToken = await firebaseAdmin.auth().verifyIdToken(bearerMatch[1], true);
        firebaseUid = decodedToken.uid;
        email = String(decodedToken.email || '').trim().toLowerCase();
      } catch (tokenErr) {
        console.warn('[firebase-sync] Token verification failed:', tokenErr.message);
        return res.status(401).json({ error: 'Invalid or expired Firebase ID token.' });
      }
    } else {
      // Development mode fallback: Decode token or accept client payload
      if (bearerMatch) {
        try {
          const decoded = jwt.decode(bearerMatch[1]);
          if (decoded) {
            decodedToken = {
              uid: decoded.user_id || decoded.sub || decoded.uid,
              email: decoded.email,
              email_verified: decoded.email_verified !== undefined ? decoded.email_verified : true,
            };
            firebaseUid = decodedToken.uid;
            email = String(decodedToken.email || '').trim().toLowerCase();
          }
        } catch (decodeErr) {
          console.warn('[firebase-sync] Could not decode bearer token:', decodeErr.message);
        }
      }

      if (!firebaseUid && req.body.firebaseUid) {
        firebaseUid = req.body.firebaseUid;
      }
      if (!email && req.body.email) {
        email = String(req.body.email).trim().toLowerCase();
      }

      if (!decodedToken) {
        decodedToken = {
          uid: firebaseUid,
          email: email,
          email_verified: true,
        };
      } else {
        decodedToken.uid = decodedToken.uid || firebaseUid;
        decodedToken.email = decodedToken.email || email;
        if (decodedToken.email_verified === undefined) decodedToken.email_verified = true;
      }

      console.log(`[firebase-sync] Syncing user ${email} (${firebaseUid}) in development mode.`);
    }

    if (!firebaseUid || !email) {
      return res.status(400).json({ error: 'Firebase token or payload must contain a user ID and email.' });
    }

    const { displayName, avatarUrl, coverUrl, bio, username, location, website, about, skills, avatarBase64, coverBase64 } = req.body;
    const requestedUsername = typeof username === 'string' ? normalizeUsername(username) : '';
    if (requestedUsername && !isValidUsername(requestedUsername)) {
      return res.status(400).json({ error: 'Username must be 3 to 30 characters using letters, numbers, and underscores.' });
    }

    let finalAvatarUrl = avatarUrl || '';
    if (avatarBase64 && typeof avatarBase64 === 'string' && avatarBase64.length > 50) {
      const uploaded = await uploadBase64ToStorage(avatarBase64, 'avatar');
      if (uploaded) finalAvatarUrl = uploaded;
    }

    let finalCoverUrl = coverUrl || '';
    if (coverBase64 && typeof coverBase64 === 'string' && coverBase64.length > 50) {
      const uploaded = await uploadBase64ToStorage(coverBase64, 'cover');
      if (uploaded) finalCoverUrl = uploaded;
    }

    // Identity is the Firebase uid and the verified email. A shared display name must not attach this login to another account.
    let user = await User.findOne({ firebaseUid });
    if (user && email && String(user.email || '').toLowerCase() !== email) {
      await User.updateOne({ _id: user._id }, { $unset: { firebaseUid: '' } });
      user = null;
    }
    if (!user) {
      user = await User.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') });
      if (user?.firebaseUid && user.firebaseUid !== firebaseUid) {
        return res.status(409).json({
          code: 'FIREBASE_ACCOUNT_MISMATCH',
          error: 'This email is already linked to another sign-in account. Sign in with the linked account.'
        });
      }
      if (user && !decodedToken.email_verified) {
        return res.status(403).json({
          code: 'VERIFIED_EMAIL_REQUIRED',
          error: 'Verify this email address before linking it to the existing account.'
        });
      }
    }

    const rememberLoginProvider = (account) => {
      if (!account) return;
      const raw = String(
        decodedToken?.firebase?.sign_in_provider ||
        decodedToken?.firebase?.signInProvider ||
        ''
      ).toLowerCase();
      let provider = 'email';
      if (raw.includes('google')) provider = 'google';
      else if (raw.includes('apple')) provider = 'apple';
      else if (raw.includes('facebook')) provider = 'facebook';
      else if (raw.includes('password') || raw.includes('email')) provider = 'email';
      else if (String(email || '').includes('@gmail.') || String(email || '').includes('@googlemail.')) provider = 'google';
      account.connectedAccounts = Array.isArray(account.connectedAccounts) ? account.connectedAccounts : [];
      const existing = account.connectedAccounts.find((item) => item.provider === provider);
      if (existing) {
        existing.email = email || existing.email || '';
        existing.uid = firebaseUid || existing.uid || '';
        existing.connectedAt = new Date();
      } else {
        account.connectedAccounts.push({
          provider,
          email: email || account.email || '',
          uid: firebaseUid || '',
          connectedAt: new Date(),
        });
      }
    };

    const isExplicitSetup = req.body.profileSetupCompleted === true;

    if (user) {
      const originalUsername = user.username;
      let usernameConflict = false;

      // Only attempt to change username if explicitly supplied and different from existing
      if (requestedUsername && requestedUsername !== normalizeUsername(user.username)) {
        if (!(await isUsernameAvailable(requestedUsername, user._id))) {
          return res.status(409).json({
            code: 'USERNAME_TAKEN',
            error: 'Username is already in use. Please choose another username.'
          });
        }
        user.username = requestedUsername;
      }

      user.firebaseUid = firebaseUid;

      // Preserve existing profile details unless this is an explicit profile setup/update
      // Requirement: Do not overwrite an existing user's display name, avatar, bio, username, or other profile information every time they sign in with Google.
      if (isExplicitSetup) {
        if (displayName) user.displayName = displayName;
        if (finalAvatarUrl && !finalAvatarUrl.includes('maya_chen_avatar')) user.avatarUrl = finalAvatarUrl;
        if (finalCoverUrl) user.coverUrl = finalCoverUrl;
        if (bio !== undefined && bio !== null && bio !== '') user.bio = bio;
        if (location !== undefined && location !== '') user.location = location;
        if (website !== undefined && website !== '') user.website = website;
        if (about !== undefined && about !== '') user.about = about;
        if (skills !== undefined) {
          user.skills = Array.isArray(skills) ? skills : String(skills).split(',').map(s => s.trim()).filter(Boolean);
        }
        user.profileSetupCompleted = true;
      } else {
        // Routine Google Sign-In: Only set fields if currently missing on user profile
        if (!user.displayName && displayName) user.displayName = displayName;
        if (!user.avatarUrl && finalAvatarUrl && !finalAvatarUrl.includes('maya_chen_avatar')) user.avatarUrl = finalAvatarUrl;
      }

      rememberLoginProvider(user);
      try {
        await user.save();
      } catch (saveErr) {
        // A competing sync may claim the username after the ownership check.
        if (saveErr.code === 11000 && saveErr.keyPattern?.username && user.username !== originalUsername) {
          user.username = originalUsername;
          usernameConflict = true;
          await user.save();
        } else if (saveErr.code === 11000 && saveErr.keyPattern?.firebaseUid) {
          return res.status(409).json({
            code: 'FIREBASE_ACCOUNT_MISMATCH',
            error: 'This Firebase account is already linked to another profile.'
          });
        } else if (saveErr.code === 11000 && saveErr.keyPattern?.email) {
          return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already linked to another account.' });
        } else {
          throw saveErr;
        }
      }
      if (req.session) {
        req.session.userId = user._id;
        req.session.authVersion = Number(user.authVersion || 0);
      }
      const userObj = toAuthenticatedUser(user);
      return res.json({
        user: userObj,
        token: createUserSessionToken(user),
        isNewUser: false,
        profileSetupCompleted: isProfileCompleted(user),
        ...(usernameConflict ? { warning: 'Username is already in use; your existing username was kept.' } : {})
      });
    }

    // Create new user profile
    let finalUsername = normalizeUsername(username || displayName || email.split('@')[0] || 'artist');
    if (!isValidUsername(finalUsername)) {
      finalUsername = 'artist_' + Math.floor(1000 + Math.random() * 9000);
    }
    if (!(await isUsernameAvailable(finalUsername))) {
      finalUsername = finalUsername.slice(0, 24) + '_' + Math.floor(100 + Math.random() * 900);
    }

    user = new User({
      firebaseUid,
      email,
      username: finalUsername,
      displayName: displayName || finalUsername,
      avatarUrl: (finalAvatarUrl && !finalAvatarUrl.includes('maya_chen_avatar')) ? finalAvatarUrl : '',
      coverUrl: finalCoverUrl || '',
      bio: bio || '',
      location: location || '',
      website: website || '',
      about: about || bio || '',
      skills: Array.isArray(skills) ? skills : (skills ? String(skills).split(',').map(s => s.trim()).filter(Boolean) : []),
      profileSetupCompleted: isExplicitSetup,
    });
    rememberLoginProvider(user);
    try {
      await user.save();
    } catch (saveErr) {
      if (saveErr.code === 11000 && saveErr.keyPattern?.username) {
        return res.status(409).json({
          code: 'USERNAME_TAKEN',
          error: 'Username is already in use. Please choose another username.'
        });
      }
      if (saveErr.code === 11000 && saveErr.keyPattern?.firebaseUid) {
        const racedUser = await User.findOne({ firebaseUid });
        if (racedUser && (!requestedUsername || requestedUsername === racedUser.username)) {
          if (req.session) {
            req.session.userId = racedUser._id;
            req.session.authVersion = Number(racedUser.authVersion || 0);
          }
          return res.json({ user: toAuthenticatedUser(racedUser), token: createUserSessionToken(racedUser) });
        }
        return res.status(409).json({ code: 'FIREBASE_ACCOUNT_MISMATCH', error: 'This Firebase account is already linked to another profile.' });
      }
      if (saveErr.code === 11000 && saveErr.keyPattern?.email) {
        return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already linked to another account.' });
      }
      throw saveErr;
    }
    if (req.session) {
      req.session.userId = user._id;
      req.session.authVersion = Number(user.authVersion || 0);
    }
    const userObj = toAuthenticatedUser(user);
    res.status(201).json({
      user: userObj,
      token: createUserSessionToken(user),
      isNewUser: true,
      profileSetupCompleted: Boolean(user.profileSetupCompleted)
    });
  } catch (err) {
    console.error('Error during firebase-sync:', err);
    res.status(500).json({ error: 'Failed to sync user.' });
  }
});

// Account lookup uses id, Firebase uid, exact username, or email. Display name is not unique and is not an identity.
const findUserByIdOrFirebaseUid = async (ident) => {
  if (!ident) return null;
  const clean = String(ident).trim();
  if (mongoose.Types.ObjectId.isValid(clean) && /^[a-f\d]{24}$/i.test(clean)) {
    const u = await User.findById(clean);
    if (u) return u;
  }
  const username = normalizeUsername(clean);
  return await User.findOne({
    $or: [
      { firebaseUid: clean },
      ...(username ? [{ username: new RegExp('^' + escapeRegex(username) + '$', 'i') }] : []),
      { email: new RegExp(`^${escapeRegex(clean.toLowerCase())}$`, 'i') }
    ]
  });
};

const contentOwnedByUser = (user) => {
  const clauses = [{ userId: user._id }];
  if (user.email) clauses.push({ userId: null, userEmail: user.email });
  if (user.username) clauses.push({ userId: null, author: user.username });
  return { $or: clauses };
};

app.get('/api/users/me/analytics', authenticateUser, async (req, res) => {
  try {
    const user = req.user;
    const postFilter = contentOwnedByUser(user);
    const posts = await Post.find(postFilter)
      .select('title viewsCount views likesCount comments createdAt')
      .lean();

    let totalViews = 0;
    let totalLikes = 0;
    let totalComments = 0;
    let topPost = null;
    posts.forEach((p) => {
      const views = Number(p.viewsCount || parseInt(String(p.views || '0'), 10) || 0);
      const likes = Number(p.likesCount || 0);
      const comments = Array.isArray(p.comments) ? p.comments.length : 0;
      totalViews += views;
      totalLikes += likes;
      totalComments += comments;
      if (!topPost || views > (topPost.viewsCount || 0)) {
        topPost = { title: p.title || 'Untitled', viewsCount: views, id: p._id };
      }
    });

    const courses = await Course.find({
      $or: [{ userId: user._id }, { userEmail: user.email }],
    }).select('enrolledCount completedCount').lean();

    const totalEnrolls = courses.reduce((sum, c) => sum + Number(c.enrolledCount || 0), 0);
    const connections = Array.isArray(user.followers) ? user.followers.length : 0;
    const following = Array.isArray(user.following) ? user.following.length : 0;
    const profileVisits = Number(user.profileVisitsCount || (user.profileVisitors || []).length || 0);
    const engagementBase = totalViews > 0 ? totalViews : 0;
    const engagementRate = engagementBase > 0
      ? Number((((totalLikes + totalComments) / engagementBase) * 100).toFixed(1))
      : 0;

    res.json({
      totalViews,
      profileVisits,
      connections,
      following,
      totalLikes,
      totalComments,
      engagementRate,
      postsPublished: posts.length,
      coursesPublished: courses.length,
      totalEnrolls,
      topPost: topPost || null,
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

app.get('/api/users/me/created-courses', authenticateUser, async (req, res) => {
  try {
    const user = req.user;
    const courses = await Course.find({
      $or: [{ userId: user._id }, { userEmail: user.email }],
    })
      .populate('enrolledStudents', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .lean();

    res.json(
      (courses || []).map((course) => {
        const students = Array.isArray(course.enrolledStudents) ? course.enrolledStudents : [];
        const enrolledCount = Number(course.enrolledCount || students.length || 0);
        const completedCount = Number(course.completedCount || 0);
        return {
          id: course._id,
          _id: course._id,
          title: course.title || 'Untitled course',
          thumbnailUrl: course.thumbnailUrl || course.image || course.previewUrl || '',
          enrolledCount,
          completedCount,
          rating: Number(course.rating || 0),
          ratingCount: Number(course.ratingCount || 0),
          enrolled: `${enrolledCount} enrolled`,
          completionRate: enrolledCount > 0 ? Math.round((completedCount / enrolledCount) * 100) : 0,
          enrolledStudents: students.map((student) => ({
            id: student._id,
            name: student.displayName || student.username || 'Student',
            username: student.username ? `@${String(student.username).replace(/^@/, '')}` : '',
            avatarUrl: student.avatarUrl || '',
          })),
        };
      })
    );
  } catch (err) {
    console.error('Created courses error:', err);
    res.status(500).json({ error: 'Failed to load course performance.' });
  }
});

app.get('/api/users/me/creator-tools', authenticateUser, async (req, res) => {
  try {
    const user = req.user;
    res.json({
      acceptTips: Boolean(user.acceptTips),
      defaultLicense: user.defaultLicense || 'all-rights-reserved',
      payout: {
        method: user.payout?.method || 'none',
        paypalEmail: user.payout?.paypalEmail || '',
        stripeAccount: user.payout?.stripeAccount || '',
        bankDetails: user.payout?.bankDetails || '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load creator tools.' });
  }
});

app.put('/api/users/me/creator-tools', authenticateUser, async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body?.acceptTips === 'boolean') updates.acceptTips = req.body.acceptTips;
    if (typeof req.body?.defaultLicense === 'string') updates.defaultLicense = req.body.defaultLicense;
    if (req.body?.payout && typeof req.body.payout === 'object') {
      const method = ['none', 'paypal', 'stripe', 'bank'].includes(req.body.payout.method)
        ? req.body.payout.method
        : 'none';
      updates.payout = {
        method,
        paypalEmail: String(req.body.payout.paypalEmail || '').trim(),
        stripeAccount: String(req.body.payout.stripeAccount || '').trim(),
        bankDetails: String(req.body.payout.bankDetails || '').trim(),
      };
    }
    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true });
    res.json({
      acceptTips: Boolean(user.acceptTips),
      defaultLicense: user.defaultLicense || 'all-rights-reserved',
      payout: {
        method: user.payout?.method || 'none',
        paypalEmail: user.payout?.paypalEmail || '',
        stripeAccount: user.payout?.stripeAccount || '',
        bankDetails: user.payout?.bankDetails || '',
      },
    });
  } catch (err) {
    console.error('Creator tools save error:', err);
    res.status(500).json({ error: 'Failed to save creator tools.' });
  }
});

app.post('/api/users/:id/visit', authenticateIfProvided, async (req, res) => {
  try {
    const target = await findUserByIdOrFirebaseUid(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const viewerId = req.user?._id ? String(req.user._id) : '';
    if (viewerId && viewerId === String(target._id)) {
      return res.json({ profileVisitsCount: target.profileVisitsCount || 0 });
    }
    if (viewerId) {
      const already = (target.profileVisitors || []).some((id) => String(id) === viewerId);
      if (!already) {
        await User.updateOne(
          { _id: target._id },
          { $addToSet: { profileVisitors: req.user._id }, $inc: { profileVisitsCount: 1 } }
        );
      }
    } else {
      await User.updateOne({ _id: target._id }, { $inc: { profileVisitsCount: 1 } });
    }
    const fresh = await User.findById(target._id).select('profileVisitsCount');
    res.json({ profileVisitsCount: fresh?.profileVisitsCount || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record profile visit.' });
  }
});

app.get('/api/users/me/activity', authenticateUser, async (req, res) => {
  try {
    const pickThumb = (post = {}) => {
      const bunnyHost = process.env.BUNNY_STREAM_CDN_HOSTNAME;
      const guid = post.bunnyVideoId || (String(post.mediaUrl || '').match(/vz-[^/]+\.b-cdn\.net\/([^/]+)/) || [])[1];
      const bunnyThumb = guid && bunnyHost ? `https://${bunnyHost}/${guid}/thumbnail.jpg` : '';
      const candidates = [
        post.thumbnailUrl,
        post.previewUrl,
        post.coverUrl,
        post.bannerUrl,
        Array.isArray(post.images) ? post.images[0] : null,
        post.extraMediaUrl,
        bunnyThumb,
        post.image,
        post.mediaType === 'video' ? null : post.mediaUrl,
      ];
      return candidates.find((url) => {
        if (!url || typeof url !== 'string') return false;
        const lower = url.toLowerCase();
        return !lower.endsWith('.mp4') && !lower.endsWith('.m3u8') && !lower.includes('play_720p') && !lower.includes('play_480p');
      }) || bunnyThumb || '';
    };

    const serializePost = (post) => {
      if (!post) return null;
      const obj = post.toObject ? post.toObject() : post;
      const artist = obj.userId?.displayName || obj.userId?.username || obj.author || 'Artist';
      return {
        id: obj._id,
        _id: obj._id,
        title: obj.title,
        thumbnail: pickThumb(obj),
        thumbnailUrl: pickThumb(obj),
        image: pickThumb(obj),
        previewUrl: obj.previewUrl,
        artist,
        author: artist,
        avatar: obj.userId?.avatarUrl || obj.avatarUrl,
        avatarUrl: obj.userId?.avatarUrl || obj.avatarUrl,
        mediaType: obj.mediaType,
        mp4Url: obj.mp4Url,
        hlsUrl: obj.hlsUrl,
        mediaUrl: obj.mediaUrl,
        bunnyVideoId: obj.bunnyVideoId,
        likes: obj.likesCount,
        likesCount: obj.likesCount,
        views: obj.views,
        createdAt: obj.createdAt,
        isLiked: true,
      };
    };

    const user = await User.findById(req.user._id).select('likedPosts').lean();
    const likedIds = (user?.likedPosts || []).filter(Boolean).slice(-80);
    const likedPosts = likedIds.length
      ? await Post.find({ _id: { $in: likedIds } })
          .select('title thumbnailUrl image previewUrl coverUrl bannerUrl images extraMediaUrl mediaUrl author avatarUrl userId mp4Url hlsUrl mediaType likesCount views viewsCount createdAt bunnyVideoId')
          .populate('userId', 'displayName username avatarUrl')
          .lean()
      : [];
    const likedMap = new Map(likedPosts.map((post) => [String(post._id), post]));
    const likes = likedIds
      .map((id) => serializePost(likedMap.get(String(id))))
      .filter(Boolean)
      .reverse();

    const commentedPosts = await Post.find({
      $or: [
        { 'comments.userId': req.user._id },
        { 'comments.userId': String(req.user._id) },
      ],
    })
      .select('title thumbnailUrl image previewUrl coverUrl bannerUrl images extraMediaUrl mediaUrl author avatarUrl comments userId createdAt mediaType mp4Url hlsUrl bunnyVideoId')
      .populate('userId', 'displayName username avatarUrl')
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    const comments = [];
    commentedPosts.forEach((post) => {
      (post.comments || []).forEach((comment) => {
        if (String(comment.userId?._id || comment.userId || '') !== String(req.user._id)) return;
        comments.push({
          id: comment._id,
          postId: post._id,
          userId: comment.userId?._id || comment.userId,
          text: comment.text,
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
          post: serializePost(post),
        });
      });
    });
    comments.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ comments, likes });
  } catch (err) {
    console.error('Failed to load activity:', err);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

app.get('/api/users/me/privacy-controls', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('blockedUsers restrictedWords')
      .populate('blockedUsers', 'displayName username avatarUrl');
    res.json({
      blockedAccounts: serializeBlockedAccounts(user?.blockedUsers || []),
      restrictedWords: user?.restrictedWords || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load privacy controls' });
  }
});

app.put('/api/users/me/privacy-controls', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (Array.isArray(req.body?.restrictedWords)) {
      user.restrictedWords = [...new Set(
        req.body.restrictedWords
          .map((word) => String(word || '').trim().toLowerCase())
          .filter((word) => word.length > 0 && word.length <= 40)
      )].slice(0, 50);
    }

    if (Array.isArray(req.body?.blockedAccounts)) {
      user.blockedUsers = req.body.blockedAccounts
        .map((entry) => {
          const raw = entry && typeof entry === 'object' ? (entry.id || entry._id) : entry;
          return mongoose.Types.ObjectId.isValid(raw) ? raw : null;
        })
        .filter(Boolean);
    }

    await user.save();
    await user.populate('blockedUsers', 'displayName username avatarUrl');
    res.json({
      blockedAccounts: serializeBlockedAccounts(user.blockedUsers),
      restrictedWords: user.restrictedWords || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save privacy controls' });
  }
});

app.post('/api/users/:id/block', authenticateUser, async (req, res) => {
  try {
    const target = await findUserByIdOrFirebaseUid(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (String(target._id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot block yourself.' });
    }
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { blockedUsers: target._id } });
    const user = await User.findById(req.user._id)
      .select('blockedUsers restrictedWords')
      .populate('blockedUsers', 'displayName username avatarUrl');
    res.json({
      blockedAccounts: serializeBlockedAccounts(user.blockedUsers),
      restrictedWords: user.restrictedWords || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to block user' });
  }
});

app.delete('/api/users/:id/block', authenticateUser, async (req, res) => {
  try {
    const target = await findUserByIdOrFirebaseUid(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await User.findByIdAndUpdate(req.user._id, { $pull: { blockedUsers: target._id } });
    const user = await User.findById(req.user._id)
      .select('blockedUsers restrictedWords')
      .populate('blockedUsers', 'displayName username avatarUrl');
    res.json({
      blockedAccounts: serializeBlockedAccounts(user.blockedUsers),
      restrictedWords: user.restrictedWords || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

const ReportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  targetPostId: { type: String, default: '' },
  targetCourseId: { type: String, default: '' },
  targetType: { type: String, enum: ['video', 'artwork', 'profile', 'course'], default: 'video' },
  reason: { type: String, default: 'other' },
  details: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'resolved', 'dismissed'], default: 'pending' },
  adminAction: { type: String, default: '' },
  targetTitle: { type: String, default: '' },
  targetName: { type: String, default: '' },
  targetThumbnail: { type: String, default: '' },
  targetMediaUrl: { type: String, default: '' },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
const ContentReport = mongoose.models.ContentReport || mongoose.model('ContentReport', ReportSchema);

app.post('/api/reports', authenticateUser, async (req, res) => {
  try {
    const allowedReasons = ['spam', 'harassment', 'sexual', 'violence', 'copyright', 'other'];
    const allowedTypes = ['video', 'artwork', 'profile', 'course'];
    const reason = allowedReasons.includes(req.body?.reason) ? req.body.reason : 'other';
    const targetType = allowedTypes.includes(req.body?.targetType) ? req.body.targetType : 'video';
    const report = await ContentReport.create({
      reporterId: req.user._id,
      targetUserId: mongoose.Types.ObjectId.isValid(req.body?.targetUserId) ? req.body.targetUserId : undefined,
      targetPostId: String(req.body?.targetPostId || ''),
      targetCourseId: String(req.body?.targetCourseId || ''),
      targetType,
      reason,
      details: String(req.body?.details || '').slice(0, 1000),
      targetTitle: String(req.body?.targetTitle || '').slice(0, 200),
      targetName: String(req.body?.targetName || '').slice(0, 120),
      targetThumbnail: String(req.body?.targetThumbnail || '').slice(0, 500),
      targetMediaUrl: String(req.body?.targetMediaUrl || '').slice(0, 500),
    });
    res.json({ ok: true, id: report._id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const reports = await ContentReport.find({})
      .sort({ createdAt: -1 })
      .populate('reporterId', 'displayName username avatarUrl email')
      .populate('targetUserId', 'displayName username avatarUrl isBanned');
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

app.post('/api/reports/:id/action', async (req, res) => {
  try {
    const report = await ContentReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const action = String(req.body?.action || '');

    if (action === 'remove_content') {
      if (report.targetPostId && mongoose.Types.ObjectId.isValid(report.targetPostId)) {
        await Post.findByIdAndDelete(report.targetPostId);
      }
      if (report.targetCourseId && mongoose.Types.ObjectId.isValid(report.targetCourseId)) {
        await Course.findByIdAndDelete(report.targetCourseId);
      }
      report.adminAction = 'remove_content';
      report.status = 'resolved';
    } else if (action === 'block_artist') {
      if (report.targetUserId) {
        await User.findByIdAndUpdate(report.targetUserId, { isBanned: true });
      }
      report.adminAction = 'block_artist';
      report.status = 'resolved';
    } else if (action === 'dismiss') {
      report.adminAction = 'dismiss';
      report.status = 'dismissed';
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    report.resolvedAt = new Date();
    await report.save();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// Get all users/artists
app.get('/api/users', authenticateIfProvided, async (req, res) => {
  try {
    const { limit, skip } = parsePageLimit(req.query, 60, 100);
    const users = await User.find({ isBanned: { $ne: true } })
      .select('-password -authVersion -email -firebaseUid -pushTokens -connectionRequests -sentRequests -blockedUsers -restrictedWords -likedPosts -enrolledCourses -payout -profileVisitors')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const blockedIds = new Set((req.user?.blockedUsers || []).map((id) => String(id)));
    res.json(users
      .filter((user) => !blockedIds.has(String(user._id)))
      .map(toPublicUser));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user profile
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(toPublicUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update user profile — authentication + ownership required
app.put('/api/users/:id', authenticateUser, async (req, res) => {
  try {
    const { displayName, bio, avatarUrl, coverUrl, username, location, website, about, skills, isPrivate } = req.body;
    // Email is locked to the sign-in identity and cannot be changed here.
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only the account owner or an admin may update this profile
    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only edit your own profile.' });
    }

    if (isPrivate !== undefined) user.isPrivate = Boolean(isPrivate);
    const nextDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
    if (username !== undefined) {
      const cleanHandle = normalizeUsername(username);
      if (!cleanHandle) return res.status(400).json({ error: 'Username is required.' });
      if (cleanHandle !== normalizeUsername(user.username)) {
        if (!isValidUsername(cleanHandle)) {
          return res.status(400).json({ error: 'Username must be 3 to 30 characters using letters, numbers, and underscores.' });
        }
        if (!(await isUsernameAvailable(cleanHandle, user._id))) {
          if (nextDisplayName) {
            user.displayName = nextDisplayName;
            await user.save();
          }
          return res.status(409).json({
            code: 'USERNAME_TAKEN',
            error: nextDisplayName
              ? 'That username is taken. Your name was saved; choose a different username.'
              : 'Username is already in use. Please choose another username.'
          });
        }
        user.username = cleanHandle;
      }
    }
    if (nextDisplayName) user.displayName = nextDisplayName;
    if (bio !== undefined) user.bio = bio;
    if (location !== undefined) user.location = location;
    if (website !== undefined) user.website = website;
    if (about !== undefined) user.about = about;
    if (req.body.profileSetupCompleted !== undefined) {
      user.profileSetupCompleted = Boolean(req.body.profileSetupCompleted);
    } else if (user.bio || user.about) {
      user.profileSetupCompleted = true;
    }
    if (skills !== undefined) {
      user.skills = Array.isArray(skills) ? skills : String(skills).split(',').map(s => s.trim()).filter(Boolean);
    }

    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.startsWith('data:')) {
      const up = await uploadBase64ToStorage(avatarUrl, 'avatar');
      if (up) user.avatarUrl = up;
    } else if (avatarUrl !== undefined && avatarUrl !== '') {
      user.avatarUrl = avatarUrl;
    }

    if (coverUrl && typeof coverUrl === 'string' && coverUrl.startsWith('data:')) {
      const up = await uploadBase64ToStorage(coverUrl, 'cover');
      if (up) user.coverUrl = up;
    } else if (coverUrl !== undefined && coverUrl !== '') {
      user.coverUrl = coverUrl;
    }

    await user.save();

    // Also update author/avatarUrl in user's posts if displayName or avatar changed
    if (user.displayName || user.username || user.avatarUrl) {
      try {
        const updateDoc = {};
        if (user.displayName || user.username) updateDoc.author = user.displayName || user.username;
        if (user.avatarUrl) updateDoc.avatarUrl = user.avatarUrl;
        await Post.updateMany(
          { $or: [{ userId: user._id }, { userEmail: user.email }] },
          { $set: updateDoc }
        );
      } catch (postUpdateErr) {
        console.warn("Post author sync notice:", postUpdateErr);
      }
    }

    res.json(toAuthenticatedUser(user));
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.username) {
      return res.status(409).json({
        code: 'USERNAME_TAKEN',
        error: 'Username is already in use. Please choose another username.'
      });
    }
    console.error("Profile update error:", err);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// Upload user avatar — authentication + ownership required
app.post('/api/users/:id/avatar', authenticateUser, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only update your own avatar.' });
    }
    const avatarUrl = await uploadToCloudinary(req.file);
    user.avatarUrl = avatarUrl;
    await user.save();
    
    // Sync posts
    await Post.updateMany({ $or: [{ userId: user._id }, { userEmail: user.email }] }, { $set: { avatarUrl } });

    const userObj = user.toObject();
    userObj.id = userObj._id;
    delete userObj.password;
    res.json(userObj);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// Upload user cover — authentication + ownership required
app.post('/api/users/:id/cover', authenticateUser, upload.single('cover'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only update your own cover.' });
    }
    const coverUrl = await uploadToCloudinary(req.file);
    user.coverUrl = coverUrl;
    await user.save();
    const userObj = user.toObject();
    userObj.id = userObj._id;
    delete userObj.password;
    res.json(userObj);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload cover' });
  }
});

// Get user's posts
app.get('/api/users/:id/posts', authenticateIfProvided, async (req, res) => {
  try {
    const rawId = req.params.id;
    const user = await findUserByIdOrFirebaseUid(rawId);
    let filter = {};
    if (user) {
      const isOwnProfile = Boolean(req.user && String(req.user._id) === String(user._id));
      const isConnected = Boolean(req.user && (user.followers || []).some((f) => String(f) === String(req.user._id)));

      // Gating for private profiles
      if (user.isPrivate && !isOwnProfile && !isConnected && req.user?.role !== 'admin') {
        return res.json([]);
      }

      filter = { ...filter, ...contentOwnedByUser(user) };
      if (!isOwnProfile && req.user?.role !== 'admin') filter.visibility = 'public';
    } else if (/^[a-f\d]{24}$/i.test(rawId)) {
      filter = { userId: rawId, visibility: 'public' };
    } else if (String(rawId).includes('@')) {
      filter = { visibility: 'public', userEmail: String(rawId).toLowerCase() };
    } else {
      return res.json([]);
    }
    const { limit, skip } = parsePageLimit(req.query, 50, 100);
    const posts = await Post.find(filter)
      .select('-userEmail -artSvg')
      .populate('userId', 'username displayName avatarUrl coverUrl bio')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    res.json(posts);
  } catch (err) {
    console.error('Failed to fetch user posts:', err);
    res.status(500).json({ error: 'Failed to fetch user posts' });
  }
});

// Get user public profile by account id, username, or email
app.get('/api/users/profile/:identifier', authenticateIfProvided, async (req, res) => {
  try {
    const ident = (req.params.identifier || '').trim();
    if (!ident) return res.status(400).json({ error: 'Identifier required' });

    let user = /^[a-f\d]{24}$/i.test(ident) ? await User.findById(ident) : null;
    if (!user) {
      const username = normalizeUsername(ident);
      user = username
        ? await User.findOne({ username: new RegExp(`^${escapeRegex(username)}$`, 'i') })
        : null;
    }
    if (!user && ident.includes('@')) {
      user = await User.findOne({ email: new RegExp(`^${escapeRegex(ident)}$`, 'i') });
    }
    if (!user) {
      const artist = await Artist.findOne({ name: new RegExp(`^${escapeRegex(ident)}$`, 'i') });
      if (!artist) return res.status(404).json({ error: 'User not found.' });
      const postCount = 0;
      return res.json({
        _id: artist ? artist._id : null,
        id: artist ? artist._id : null,
        displayName: artist ? artist.name : ident,
        username: ident.toLowerCase().replace(/[\s_]+/g, ''),
        bio: artist ? artist.bio : 'Digital Creator',
        avatarUrl: artist ? artist.avatar : '',
        coverUrl: artist ? (artist.coverUrl || '') : '',
        followers: [],
        followersCount: artist ? (parseInt(artist.followers, 10) || 0) : 0,
        followingCount: 0,
        artworksCount: postCount,
        isPrivate: false,
        isConnected: false,
        isRequested: false,
        isLocked: false,
      });
    }

    const viewerId = req.user?._id ? req.user._id.toString() : null;
    const isOwner = Boolean(viewerId && viewerId === user._id.toString());
    const isConnected = Boolean(viewerId && (user.followers || []).some((f) => f.toString() === viewerId));
    const isRequested = Boolean(viewerId && (user.connectionRequests || []).some((r) => r.toString() === viewerId));

    const userObj = toPublicUser(user);
    userObj.isPrivate = !!user.isPrivate;
    userObj.isConnected = isConnected;
    userObj.isRequested = isRequested;
    userObj.isOwner = isOwner;
    userObj.followersCount = (user.followers || []).length;
    userObj.followingCount = (user.following || []).length;
    userObj.artworksCount = Number(user.artworksCount || 0);

    // Content lock for private accounts
    if (user.isPrivate && !isOwner && !isConnected && req.user?.role !== 'admin') {
      userObj.isLocked = true;
      userObj.about = '';
      userObj.location = '';
      userObj.website = '';
      userObj.skills = [];
      return res.json(userObj);
    }

    userObj.isLocked = false;
    res.json(userObj);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Follow/Unfollow a user (by ID or creatorName) with Private Account Request Staging
app.post('/api/users/:id/follow', authenticateUser, async (req, res) => {
  try {
    const { creatorName } = req.body;
    const followerUser = req.user;

    const rawTarget = (creatorName || req.params.id || '').trim();
    const searchTarget = rawTarget.replace(/^@/, '');

    // Gate: Check if user is trying to follow themselves
    if (
      (followerUser._id && req.params.id && followerUser._id.toString() === req.params.id) ||
      (followerUser.username && searchTarget && followerUser.username.toLowerCase() === normalizeUsername(searchTarget))
    ) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    let targetUser = null;
    if (req.params.id && req.params.id !== 'by-name' && /^[a-f\d]{24}$/i.test(req.params.id)) {
      targetUser = await User.findById(req.params.id);
    }
    if (!targetUser && searchTarget) {
      const username = normalizeUsername(searchTarget);
      if (username) {
        targetUser = await User.findOne({ username: new RegExp(`^${escapeRegex(username)}$`, 'i') });
      }
    }

    if (!targetUser) {
      return res.json({ isFollowing: true, followersCount: 1, followingCount: 0 });
    }

    if (followerUser._id.toString() === targetUser._id.toString()) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const followerDoc = await User.findById(followerUser._id);
    if (!followerDoc) {
      return res.status(404).json({ error: 'Follower user not found' });
    }

    if (!Array.isArray(targetUser.followers)) targetUser.followers = [];
    if (!Array.isArray(followerDoc.following)) followerDoc.following = [];
    if (!Array.isArray(targetUser.connectionRequests)) targetUser.connectionRequests = [];
    if (!Array.isArray(followerDoc.sentRequests)) followerDoc.sentRequests = [];

    const followerId = followerDoc._id;
    const targetId = targetUser._id;
    const isFollowing = targetUser.followers.some((f) => f.toString() === followerId.toString());

    // 1. If currently following: unfollow immediately regardless of privacy
    if (isFollowing) {
      await Promise.all([
        User.updateOne({ _id: targetId }, { $pull: { followers: followerId } }),
        User.updateOne({ _id: followerId }, { $pull: { following: targetId } }),
      ]);
      return res.json({
        isFollowing: false,
        isRequested: false,
        isPending: false,
        followersCount: Math.max(0, (targetUser.followers || []).length - 1),
        followingCount: Math.max(0, (followerDoc.following || []).length - 1),
      });
    }

    // 2. If target is PRIVATE: Stage or cancel connection request
    if (targetUser.isPrivate) {
      const alreadyRequested = targetUser.connectionRequests.some((r) => r.toString() === followerId.toString());
      if (alreadyRequested) {
        await Promise.all([
          User.updateOne({ _id: targetId }, { $pull: { connectionRequests: followerId } }),
          User.updateOne({ _id: followerId }, { $pull: { sentRequests: targetId } }),
        ]);
        return res.json({
          isFollowing: false,
          isRequested: false,
          isPending: false,
          followersCount: (targetUser.followers || []).length,
          followingCount: (followerDoc.following || []).length,
          message: 'Connection request cancelled',
        });
      }

      await Promise.all([
        User.updateOne({ _id: targetId }, { $addToSet: { connectionRequests: followerId } }),
        User.updateOne({ _id: followerId }, { $addToSet: { sentRequests: targetId } }),
      ]);
      await createAndDispatchNotification({
        userId: targetId,
        actorId: followerId,
        user: followerDoc.displayName || followerDoc.username || 'Someone',
        action: 'sent you a connection request',
        text: `${followerDoc.displayName || followerDoc.username || 'Someone'} requested to connect with you`,
        avatarUrl: followerDoc.avatarUrl || '',
        type: 'connection_request',
        title: 'Connection Request',
        requesterId: followerId,
        preventDuplicatesWithinMs: 60 * 60 * 1000,
      }).catch((err) => console.error('Error creating request notification:', err));
      return res.json({
        isFollowing: false,
        isRequested: true,
        isPending: true,
        followersCount: (targetUser.followers || []).length,
        followingCount: (followerDoc.following || []).length,
        message: 'Connection request sent',
      });
    }

    // 3. If target is PUBLIC: Instant follow, then notify
    await Promise.all([
      User.updateOne({ _id: targetId }, { $addToSet: { followers: followerId } }),
      User.updateOne({ _id: followerId }, { $addToSet: { following: targetId } }),
    ]);
    await createAndDispatchNotification({
      userId: targetId,
      actorId: followerId,
      user: followerDoc.displayName || followerDoc.username || 'Someone',
      action: 'started following you',
      text: `${followerDoc.displayName || followerDoc.username || 'Someone'} started following you`,
      avatarUrl: followerDoc.avatarUrl || '',
      type: 'follow',
      title: 'New Connection',
      preventDuplicatesWithinMs: 60 * 60 * 1000,
    }).catch((err) => console.error('Error creating follow notification:', err));
    return res.json({
      isFollowing: true,
      isRequested: false,
      isPending: false,
      followersCount: (targetUser.followers || []).length + 1,
      followingCount: (followerDoc.following || []).length + 1,
    });
  } catch (err) {
    console.error('Follow error:', err);
    res.status(500).json({ error: 'Failed to follow/unfollow user' });
  }
});

// --- CONNECTION REQUESTS MANAGEMENT (ACCEPT / REJECT / LIST) ---

// Get pending connection requests for authenticated user
app.get('/api/users/connection-requests', authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('connectionRequests', 'displayName username avatarUrl bio location');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.connectionRequests || []);
  } catch (err) {
    console.error('Failed to get connection requests:', err);
    res.status(500).json({ error: 'Failed to fetch connection requests' });
  }
});

// Accept a connection request
app.post('/api/users/requests/:id/accept', authenticateUser, async (req, res) => {
  try {
    const targetUser = await User.findById(req.user._id);
    const requester = await User.findById(req.params.id);
    if (!targetUser || !requester) return res.status(404).json({ error: 'User not found' });

    if (!Array.isArray(targetUser.connectionRequests)) targetUser.connectionRequests = [];
    if (!Array.isArray(requester.sentRequests)) requester.sentRequests = [];
    if (!Array.isArray(targetUser.followers)) targetUser.followers = [];
    if (!Array.isArray(requester.following)) requester.following = [];

    targetUser.connectionRequests.pull(requester._id);
    requester.sentRequests.pull(targetUser._id);

    if (!targetUser.followers.some((f) => f.toString() === requester._id.toString())) {
      targetUser.followers.push(requester._id);
    }
    if (!requester.following.some((f) => f.toString() === targetUser._id.toString())) {
      requester.following.push(targetUser._id);
    }

    await targetUser.save();
    await requester.save();

    await Notification.updateMany(
      { userId: targetUser._id, requesterId: requester._id, type: 'connection_request' },
      { $set: { unread: false, isRead: true, action: 'request accepted' } }
    ).catch(() => {});

    await createAndDispatchNotification({
      userId: requester._id,
      actorId: targetUser._id,
      user: targetUser.displayName || targetUser.username || 'Creator',
      action: 'accepted your connection request',
      text: `${targetUser.displayName || targetUser.username || 'Creator'} accepted your connection request`,
      avatarUrl: targetUser.avatarUrl || '',
      type: 'connection_accepted',
      title: 'Connection Accepted',
      preventDuplicatesWithinMs: 60 * 60 * 1000,
    }).catch((err) => console.error('Error creating accept notification:', err));

    res.json({ success: true, message: 'Connection request accepted' });
  } catch (err) {
    console.error('Failed to accept request:', err);
    res.status(500).json({ error: 'Failed to accept connection request' });
  }
});

// Reject a connection request
app.post('/api/users/requests/:id/reject', authenticateUser, async (req, res) => {
  try {
    const targetUser = await User.findById(req.user._id);
    const requester = await User.findById(req.params.id);
    if (targetUser && requester) {
      if (Array.isArray(targetUser.connectionRequests)) targetUser.connectionRequests.pull(requester._id);
      if (Array.isArray(requester.sentRequests)) requester.sentRequests.pull(targetUser._id);
      await targetUser.save();
      await requester.save();

      await Notification.updateMany(
        { userId: targetUser._id, requesterId: requester._id, type: 'connection_request' },
        { $set: { unread: false, isRead: true, action: 'request declined' } }
      ).catch(() => {});
    }
    res.json({ success: true, message: 'Connection request rejected' });
  } catch (err) {
    console.error('Failed to reject request:', err);
    res.status(500).json({ error: 'Failed to reject connection request' });
  }
});

// Get user stats
app.get('/api/users/:id/stats', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('username email followers following');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const artworksCount = await Post.countDocuments(contentOwnedByUser(user));
    res.json({
      artworksCount,
      followersCount: user.followers.length,
      followingCount: user.following.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// Update user password — authentication + ownership required
app.put('/api/users/:id/password', authenticateUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only the account owner or an admin may change the password
    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only change your own password.' });
    }

    if (user.password) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required.' });
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// Delete user account — authentication + ownership required
app.delete('/api/users/:id', authenticateUser, async (req, res) => {
  try {
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only the account owner or an admin may delete this account
    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own account.' });
    }

    const radioChannel = await RadioChannel.findOne({ ownerId: user._id });
    if (radioChannel) {
      io.to(radioRoomName(radioChannel.frequency)).emit('radio:channel-status', { frequency: radioChannel.frequency, isLive: false });
      io.to(radioRoomName(radioChannel.frequency)).emit('radio:broadcast-stopped', { frequency: radioChannel.frequency });
      clearRadioListeners(radioChannel.frequency);
      await radioChannel.deleteOne();
    }

    // Delete all content owned by this user
    await Post.deleteMany({ $or: [{ userId: user._id }, { userEmail: user.email }] });
    await Course.deleteMany({ $or: [{ userId: user._id }, { userEmail: user.email }] });
    await Video.deleteMany({ $or: [{ userId: user._id }, { userEmail: user.email }] });

    // Remove from other users' followers/following lists
    await User.updateMany(
      { followers: user._id },
      { $pull: { followers: user._id } }
    );
    await User.updateMany(
      { following: user._id },
      { $pull: { following: user._id } }
    );

    await user.deleteOne();
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// Export user data — authentication + ownership required
app.post('/api/users/:id/export', authenticateUser, async (req, res) => {
  try {
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only export your own data.' });
    }

    const userObj = toAuthenticatedUser(user);

    const posts = await Post.find({ $or: [{ userId: user._id }, { userEmail: user.email }] })
      .select('-__v').lean();
    const courses = await Course.find({ $or: [{ userId: user._id }, { userEmail: user.email }] })
      .select('-__v').lean();
    const notifications = await Notification.find({ userId: user._id })
      .select('-__v').lean().catch(() => []);

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      profile: userObj,
      posts,
      courses,
      notifications,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="artube-data-${user._id}.json"`);
    res.json(exportPayload);
  } catch (err) {
    console.error('Export data error:', err);
    res.status(500).json({ error: 'Failed to export data.' });
  }
});

// Connect third-party provider account
app.post('/api/users/:id/connected-accounts', authenticateUser, async (req, res) => {
  try {
    const { provider, email, uid } = req.body;
    if (!provider) return res.status(400).json({ error: 'Provider is required' });
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(user._id) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only connect accounts to your own profile.' });
    }

    user.connectedAccounts = user.connectedAccounts || [];
    const existingIndex = user.connectedAccounts.findIndex(acc => acc.provider === provider);
    if (existingIndex >= 0) {
      user.connectedAccounts[existingIndex] = { provider, email: email || '', uid: uid || '', connectedAt: new Date() };
    } else {
      user.connectedAccounts.push({ provider, email: email || '', uid: uid || '', connectedAt: new Date() });
    }
    await user.save();
    res.json({ success: true, connectedAccounts: user.connectedAccounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to connect account' });
  }
});

// Disconnect third-party provider account
app.delete('/api/users/:id/connected-accounts/:provider', authenticateUser, async (req, res) => {
  try {
    const user = await findUserByIdOrFirebaseUid(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(user._id) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only disconnect accounts from your own profile.' });
    }

    user.connectedAccounts = (user.connectedAccounts || []).filter(acc => acc.provider !== req.params.provider);
    await user.save();
    res.json({ success: true, connectedAccounts: user.connectedAccounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// --- AUTHENTICATION ENDPOINTS ---

// Public preflight check for signup/profile username fields. Final writes also
// check atomically so simultaneous requests cannot claim the same handle.
app.get('/api/auth/username-availability', async (req, res, next) => {
  if (req.headers.authorization || req.session?.userId) {
    return authenticateUser(req, res, next);
  }
  next();
}, async (req, res) => {
  try {
    const username = normalizeUsername(req.query.username);
    if (!username) return res.status(400).json({ error: 'Username is required.' });
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3 to 30 characters using letters, numbers, and underscores.' });
    }
    res.json({ username, available: await isUsernameAvailable(username, req.user?._id || null) });
  } catch (err) {
    console.error('Username availability check failed:', err);
    res.status(500).json({ error: 'Could not check username availability.' });
  }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username: requestedUsername, email: requestedEmail, password } = req.body;
    const username = normalizeUsername(requestedUsername);
    const email = String(requestedEmail || '').trim().toLowerCase();
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3 to 30 characters using letters, numbers, and underscores.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    if (!(await isUsernameAvailable(username))) {
      return res.status(409).json({
        code: 'USERNAME_TAKEN',
        error: 'Username is already in use. Please choose another username.'
      });
    }
    const existingEmail = await User.exists({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') });
    if (existingEmail) {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already registered.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      role: 'user'
    });

    try {
      await newUser.save();
    } catch (saveErr) {
      if (saveErr.code === 11000 && saveErr.keyPattern?.username) {
        return res.status(409).json({
          code: 'USERNAME_TAKEN',
          error: 'Username is already in use. Please choose another username.'
        });
      }
      if (saveErr.code === 11000 && saveErr.keyPattern?.email) {
        return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already registered.' });
      }
      throw saveErr;
    }

    req.session.userId = newUser._id;
    req.session.authVersion = Number(newUser.authVersion || 0);
    const token = createUserSessionToken(newUser);
    const userObj = toAuthenticatedUser(newUser);
    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { ...userObj, id: newUser._id }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'Email/Username and password are required.' });
    }

    // Find user by username or email
    const loginIdentifier = String(emailOrUsername).trim();
    const user = await User.findOne({
      $or: [
        { email: new RegExp(`^${escapeRegex(loginIdentifier)}$`, 'i') },
        { username: new RegExp(`^${escapeRegex(normalizeUsername(loginIdentifier))}$`, 'i') }
      ]
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Save in session
    req.session.userId = user._id;
    req.session.authVersion = Number(user.authVersion || 0);

    // Generate JWT token for mobile client
    const token = createUserSessionToken(user);

    const userObj = toAuthenticatedUser(user);

    res.json({
      message: 'Login successful',
      token,
      user: {
        ...userObj,
        id: user._id,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// Get Current User Profile (Me)
app.get('/api/auth/me', authenticateUser, (req, res) => {
  res.json(toAuthenticatedUser(req.user));
});

// Revoke all backend JWTs for this account and destroy the optional cookie session.
app.post('/api/auth/logout', authenticateUser, async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $inc: { authVersion: 1 } });
    if (!req.session) return res.json({ success: true, message: 'Logged out successfully' });
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'Failed to logout' });
      res.clearCookie('connect.sid');
      res.json({ success: true, message: 'Logged out successfully' });
    });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to logout' });
  }
});

app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError')) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? 'Video uploads can be up to 1 GB. Please choose a smaller file.'
        : (err.message || 'Upload failed.'),
    });
  }
  return next(err);
});

// Start Server
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT} (HTTP + WebSocket enabled on /ws)`);
  });
}

app.locals.models = { User, Post, RadioChannel, Course, Community, Challenge, Notification };
app.locals.createUserSessionToken = createUserSessionToken;
app.locals.radioIndexesReady = radioIndexesReady;
app.locals.firebaseAdminConfigured = Boolean(firebaseAdmin);

module.exports = app;
