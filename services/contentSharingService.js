const { getDb } = require('../config/firebase');
const admin = require('firebase-admin');

class ContentSharingService {
  constructor() {
    this.db = null;
  }

  getDatabase() {
    if (!this.db) {
      this.db = getDb();
    }
    return this.db;
  }

  // 📊 GET ALL CONTENT FOR SHARING
  async getAllContent() {
    try {
      const db = this.getDatabase();
      
      const content = {
        legends: [],
        martyrs: [],
        locations: [],
        activities: [],
        news: [],
        liveNews: []
      };

      // Get Legends
      const legendsSnapshot = await db.collection('legends').orderBy('createdAt', 'desc').get();
      content.legends = legendsSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'legend',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt)
      }));

      // Get Martyrs
      const martyrsSnapshot = await db.collection('martyrs').orderBy('createdAt', 'desc').get();
      content.martyrs = martyrsSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'martyr',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
        dob: doc.data().dob?.toDate?.() || new Date(doc.data().dob),
        dateOfShahada: doc.data().dateOfShahada?.toDate?.() || new Date(doc.data().dateOfShahada)
      }));

      // Get Locations
      const locationsSnapshot = await db.collection('locations').orderBy('createdAt', 'desc').get();
      content.locations = locationsSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'location',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt)
      }));

      // Get Activities
      const activitiesSnapshot = await db.collection('activities').orderBy('createdAt', 'desc').get();
      content.activities = activitiesSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'activity',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
        date: doc.data().date?.toDate?.() || new Date(doc.data().date)
      }));

      // Get Regular News
      const newsSnapshot = await db.collection('news')
        .where('type', 'in', ['regular', 'regularLive'])
        .orderBy('createdAt', 'desc').get();
      content.news = newsSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'news',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
        publishDate: doc.data().publishDate?.toDate?.() || new Date(doc.data().publishDate)
      }));

      // Get Live News
      const liveNewsSnapshot = await db.collection('news')
        .where('type', '==', 'live')
        .orderBy('createdAt', 'desc').get();
      content.liveNews = liveNewsSnapshot.docs.map(doc => ({
        id: doc.id,
        type: 'liveNews',
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
        liveStartTime: doc.data().liveStartTime?.toDate?.() || new Date(doc.data().liveStartTime)
      }));

      return content;
    } catch (error) {
      console.error('❌ Error getting all content:', error);
      throw error;
    }
  }

  // 🖼️ EXTRACT ALL MEDIA FROM ITEM
  extractMediaFromItem(item) {
    const media = {
      images: [],
      videos: [],
      photos360: []
    };

    // Check mainIcon (base64 or URL)
    if (item.mainIcon && this.isValidUrl(item.mainIcon)) {
      media.images.push({
        url: item.mainIcon,
        type: 'mainIcon',
        caption: 'Main Icon'
      });
    }

    // Check mainImage (base64 or URL)
    if (item.mainImage && this.isValidUrl(item.mainImage)) {
      media.images.push({
        url: item.mainImage,
        type: 'mainImage',
        caption: 'Main Image'
      });
    }

    // Check photos array
    if (item.photos && Array.isArray(item.photos)) {
      item.photos.forEach((photo, index) => {
        if (photo.url && this.isValidUrl(photo.url)) {
          media.images.push({
            url: photo.url,
            type: 'photo',
            caption: photo.name || `Photo ${index + 1}`,
            size: photo.size,
            uploadedAt: photo.uploadedAt
          });
        }
      });
    }

    // Check videos array
    if (item.videos && Array.isArray(item.videos)) {
      item.videos.forEach((video, index) => {
        if (video.url && this.isValidUrl(video.url)) {
          media.videos.push({
            url: video.url,
            type: 'video',
            caption: video.name || `Video ${index + 1}`,
            size: video.size,
            uploadedAt: video.uploadedAt
          });
        }
      });
    }

    // Check 360 photos array
    if (item.photos360 && Array.isArray(item.photos360)) {
      item.photos360.forEach((photo360, index) => {
        if (photo360.url && this.isValidUrl(photo360.url)) {
          media.photos360.push({
            url: photo360.url,
            type: 'photo360',
            caption: photo360.name || `360° Photo ${index + 1}`,
            size: photo360.size,
            uploadedAt: photo360.uploadedAt
          });
        }
      });
    }

    return media;
  }

  // 🔍 CHECK IF STRING IS VALID URL
  isValidUrl(string) {
    try {
      // Skip base64 strings
      if (string.startsWith('data:')) {
        return false;
      }
      
      // Check if it's a valid URL
      new URL(string);
      return string.startsWith('http://') || string.startsWith('https://');
    } catch (_) {
      return false;
    }
  }

  // 📝 FORMAT CONTENT FOR WHATSAPP (FIXED - URLs ONLY)
  formatContentForWhatsApp(item) {
    let message = '';

    switch (item.type) {
      case 'legend':
        message = `🏛️ *Legend: ${item.nameAr || item.nameEn}*\n\n`;
        message += `📖 ${item.descriptionAr || item.descriptionEn}\n\n`;
        break;

      case 'martyr':
        message = `🌹 *Martyr: ${item.nameAr || item.nameEn}*\n\n`;
        message += `⚔️ Jihadist Name: ${item.jihadistNameAr || item.jihadistNameEn}\n`;
        message += `👨‍👩‍👧‍👦 Family Status: ${item.familyStatus}\n`;
        if (item.numberOfChildren) message += `👶 Children: ${item.numberOfChildren}\n`;
        message += `📅 Date of Shahada: ${new Date(item.dateOfShahada).toLocaleDateString()}\n`;
        message += `📖 ${(item.storyAr || item.storyEn).substring(0, 200)}...\n\n`;
        break;

      case 'location':
        message = `📍 *Location: ${item.nameAr || item.nameEn}*\n\n`;
        message += `📖 ${item.descriptionAr || item.descriptionEn}\n`;
        message += `🌍 Coordinates: ${item.latitude}, ${item.longitude}\n\n`;
        break;

      case 'activity':
        message = `🎯 *Activity: ${item.nameAr || item.nameEn}*\n\n`;
        message += `📖 ${item.descriptionAr || item.descriptionEn}\n`;
        message += `📅 Date: ${new Date(item.date).toLocaleDateString()}\n`;
        message += `⏰ Time: ${item.time}\n`;
        message += `⏳ Duration: ${item.durationHours}h\n\n`;
        break;

      case 'news':
        message = `📰 *News: ${item.titleAr || item.titleEn}*\n\n`;
        message += `📖 ${item.descriptionAr || item.descriptionEn}\n`;
        if (item.publishDate) {
          message += `📅 Published: ${new Date(item.publishDate).toLocaleDateString()}\n`;
        }
        message += `\n`;
        break;

      case 'liveNews':
        message = `🔴 *LIVE NEWS: ${item.titleAr || item.titleEn}*\n\n`;
        message += `📖 ${item.descriptionAr || item.descriptionEn}\n`;
        message += `⏰ Started: ${new Date(item.liveStartTime).toLocaleString()}\n`;
        if (item.liveDurationHours) {
          message += `⏳ Duration: ${item.liveDurationHours}h\n`;
        }
        message += `\n`;
        break;

      default:
        message = `📄 Content: ${item.nameAr || item.nameEn || item.titleAr || item.titleEn}\n\n`;
    }

    // Add media URLs
    const media = this.extractMediaFromItem(item);
    
    // Add main icon URL if exists
    if (item.mainIcon && this.isValidUrl(item.mainIcon)) {
      message += `📎 MAIN ICON:\n${item.mainIcon}\n\n`;
    }

    // Add main image URL if exists
    if (item.mainImage && this.isValidUrl(item.mainImage)) {
      message += `🖼️ MAIN IMAGE:\n${item.mainImage}\n\n`;
    }

    // Add regular images URLs
    if (media.images.length > 0) {
      message += `📷 IMAGES:\n`;
      media.images.forEach((image, index) => {
        message += `${index + 1}. ${image.url}\n`;
      });
      message += `\n`;
    }

    // Add 360° photos URLs
    if (media.photos360.length > 0) {
      message += `🌍 360° IMAGES:\n`;
      media.photos360.forEach((photo360, index) => {
        message += `${index + 1}. ${photo360.url}\n`;
      });
      message += `\n`;
    }

    // Add videos URLs
    if (media.videos.length > 0) {
      message += `🎥 VIDEOS:\n`;
      media.videos.forEach((video, index) => {
        message += `${index + 1}. ${video.url}\n`;
      });
      message += `\n`;
    }

    return { message };
  }

  // 📤 SEND CONTENT TO CONTACTS/GROUPS (UPDATED - TEXT ONLY)
  async shareContent(whatsappService, selectedContent, contactIds = [], groupIds = [], delaySeconds = 5) {
    try {
      const results = {
        success: [],
        failed: []
      };

      console.log(`📤 Sharing ${selectedContent.length} content items to ${contactIds.length} contacts and ${groupIds.length} groups`);

      for (let i = 0; i < selectedContent.length; i++) {
        const item = selectedContent[i];
        const { message } = this.formatContentForWhatsApp(item);
        
        console.log(`📤 Sharing ${item.type}: ${item.nameAr || item.nameEn || item.titleAr || item.titleEn} (${i + 1}/${selectedContent.length})`);

        // Send to contacts
        for (const contactId of contactIds) {
          try {
            // Send only the message with URLs - NO IMAGES
            await whatsappService.sendToContact(contactId, message);
            
            results.success.push({
              contentId: item.id,
              contentType: item.type,
              targetType: 'contact',
              targetId: contactId
            });
          } catch (error) {
            results.failed.push({
              contentId: item.id,
              contentType: item.type,
              targetType: 'contact',
              targetId: contactId,
              error: error.message
            });
          }
        }

        // Send to groups
        for (const groupId of groupIds) {
          try {
            // Send only the message with URLs - NO IMAGES
            await whatsappService.sendToGroup(groupId, message);
            
            results.success.push({
              contentId: item.id,
              contentType: item.type,
              targetType: 'group',
              targetId: groupId
            });
          } catch (error) {
            results.failed.push({
              contentId: item.id,
              contentType: item.type,
              targetType: 'group',
              targetId: groupId,
              error: error.message
            });
          }
        }

        // Add delay between content items to prevent spam
        if (i < selectedContent.length - 1) {
          console.log(`⏳ Waiting ${delaySeconds} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }
      }

      console.log(`📊 Sharing complete: ${results.success.length} success, ${results.failed.length} failed`);
      return results;
    } catch (error) {
      console.error('❌ Error sharing content:', error);
      throw error;
    }
  }
}

module.exports = ContentSharingService;
