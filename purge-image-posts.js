require('dotenv').config();
const mongoose = require('mongoose');

const IMAGE_ONLY_POST_FILTER = {
  $and: [
    {
      $or: [
        { mediaType: 'image' },
        { mediaType: { $nin: ['video', 'mixed'] } },
      ],
    },
    { $or: [{ bunnyVideoId: { $exists: false } }, { bunnyVideoId: null }, { bunnyVideoId: '' }] },
    { $or: [{ hlsUrl: { $exists: false } }, { hlsUrl: null }, { hlsUrl: '' }] },
    { $or: [{ mp4Url: { $exists: false } }, { mp4Url: null }, { mp4Url: '' }] },
    {
      $or: [
        { mediaUrl: { $exists: false } },
        { mediaUrl: null },
        { mediaUrl: '' },
        { mediaUrl: { $not: /\.mp4($|\?)|\.m3u8($|\?)|b-cdn\.net/i } },
      ],
    },
  ],
};

async function run() {
  const mongoURI = process.env.MONGODB_URI;
  if (!mongoURI) {
    throw new Error('MONGODB_URI is required');
  }
  await mongoose.connect(mongoURI);
  const posts = mongoose.connection.collection('posts');
  const courses = mongoose.connection.collection('courses');

  const deletedPosts = await posts.deleteMany(IMAGE_ONLY_POST_FILTER);
  const strippedPosts = await posts.updateMany(
    {
      $or: [
        { mediaType: 'mixed' },
        { images: { $exists: true, $not: { $size: 0 } } },
      ],
    },
    { $set: { mediaType: 'video', images: [], relatedImages: [], mediaUrls: [] } }
  );
  const strippedCourses = await courses.updateMany(
    {},
    { $set: { images: [], relatedImages: [] } }
  );

  console.log(JSON.stringify({
    deletedImagePosts: deletedPosts.deletedCount,
    strippedPostImages: strippedPosts.modifiedCount,
    strippedCourseImages: strippedCourses.modifiedCount,
  }));
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
