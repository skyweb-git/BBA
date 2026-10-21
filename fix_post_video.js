const mongoose = require('mongoose');

const mongoURI = 'mongodb+srv://artubeadmin:ArtubeAdmin2026!@artube-cluster.q3zmv.mongodb.net/artube?retryWrites=true&w=majority&appName=artube-cluster';

async function update() {
  await mongoose.connect(mongoURI);
  console.log('Connected to MongoDB');
  const Post = mongoose.model('Post', new mongoose.Schema({}, { strict: false }));
  const posts = await Post.find({ mediaType: 'video' });
  for (const p of posts) {
    console.log('Found video post:', p._id, p.title, p.mp4Url);
    p.mp4Url = 'https://vz-c392c4ee-5a5.b-cdn.net/e9910b9c-68c2-47d7-93d8-ac26e739f585/play_480p.mp4';
    await p.save();
    console.log('Updated post to 480p:', p._id);
  }
  process.exit(0);
}

update().catch(err => { console.error(err); process.exit(1); });
