const { getDb } = require('../config/firebase');

class NotificationEmailService {
  constructor(emailService) {
    this.emailService = emailService;
    this.db = getDb();
  }

  async sendNotificationEmails(notification, notificationId = null, options = {}) {
    try {
      console.log('🔔 Processing notification for email automation:', notification);
      
      // Get all users (used for role/village filtering and to resolve names)
      const usersSnapshot = await this.db.collection('users').get();
      const allUsers = usersSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      const emailPromises = [];

      // Helper to send to a normalized recipient list [{ email, name, role, assignedVillageId? }]
      const sendToList = async (recipientsList) => {
        if (!recipientsList || recipientsList.length === 0) {
          console.log('📭 No users need to receive email for this notification');
          return { successful: 0, failed: 0, total: 0 };
        }

        console.log(`📬 Sending ${recipientsList.length} notification emails...`);
        const results = [];
        for (let i = 0; i < recipientsList.length; i++) {
          const r = recipientsList[i];
          const roleForEmail = (r.role === 'secondary' && r.assignedVillageId) ? 'secondary_with_village' : (r.role || 'user');

          console.log(`📧 Sending email ${i + 1}/${recipientsList.length}...`);
          try {
            const result = await this.emailService.sendNotificationEmailToUser(
              r.email,
              notification,
              roleForEmail,
              r.name
            );
            results.push(result);
          } catch (error) {
            console.error(`❌ Failed to send email to ${r.email}:`, error.message);
            results.push({ success: false, email: r.email, error: error.message });
          }

          // Rate limiting delay
          if (i < recipientsList.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        const successful = results.filter(r => r && r.success).length;
        const failed = results.filter(r => !r || !r.success).length;
        console.log(`✅ Email automation completed: ${successful} sent, ${failed} failed`);
        return { successful, failed, total: recipientsList.length };
      };

      // 1) If explicit recipients are requested, honor them and do not compute server-side
      const useExplicit = options && options.recipientsOnly === true && Array.isArray(options.recipients) && options.recipients.length > 0;
      if (useExplicit) {
        const allowSet = new Set(
          options.recipients
            .map(e => (e || '').toLowerCase().trim())
            .filter(Boolean)
        );

        // Build list from known users
        const matchedUsers = allUsers.filter(u => u.email && allowSet.has(u.email.toLowerCase().trim()));

        // Include unknown emails (not present in users collection)
        const knownEmails = new Set(matchedUsers.map(u => u.email.toLowerCase().trim()));
        const unknownEmails = [...allowSet].filter(e => !knownEmails.has(e));

        // Remove performer if present
        const performerEmail = (notification.performedBy || '').toLowerCase().trim();
        const finalList = [
          ...matchedUsers
            .filter(u => u.email.toLowerCase().trim() !== performerEmail)
            .map(u => ({ email: u.email, name: u.name, role: u.role, assignedVillageId: u.assignedVillageId })),
          ...unknownEmails
            .filter(e => e !== performerEmail)
            .map(email => ({ email, name: undefined, role: 'user' }))
        ];

        // Deduplicate
        const uniqueByEmail = new Map();
        for (const r of finalList) {
          const key = r.email.toLowerCase().trim();
          if (!uniqueByEmail.has(key)) uniqueByEmail.set(key, r);
        }

        return await sendToList(Array.from(uniqueByEmail.values()));
      }

      // 2) Server-side computation per new role/village rules
      const performer =
        allUsers.find(u => (u.email || '').toLowerCase().trim() === (notification.performedBy || '').toLowerCase().trim()) || null;
      const performerRole = options.performerRole || notification.performerRole || performer?.role;
      const performerVillageId = options.performerVillageId || notification.villageId || performer?.assignedVillageId;

      let recipients = [];

      if (performerRole === 'main') {
        // Main admin -> send to no one
        recipients = [];
      } else if (performerRole === 'secondary') {
        if (performerVillageId) {
          // Secondary with village -> ONLY village editors in same village
          recipients = allUsers.filter(
            u => u.role === 'village_editor' &&
                 u.assignedVillageId === performerVillageId
          );
        } else {
          recipients = [];
        }
      } else if (performerRole === 'village_editor') {
        if (performerVillageId) {
          // Village editor -> ONLY secondary admins in same village
          recipients = allUsers.filter(
            u => u.role === 'secondary' &&
                 u.assignedVillageId === performerVillageId
          );
        } else {
          recipients = [];
        }
      } else {
        // Unknown performer role -> safest is send to no one
        recipients = [];
      }

      // Remove performer and invalid emails
      const performerEmail = (notification.performedBy || '').toLowerCase().trim();
      const dedup = new Map();
      for (const u of recipients) {
        if (!u.email) continue;
        const emailLower = u.email.toLowerCase().trim();
        if (emailLower === performerEmail) continue;
        if (!dedup.has(emailLower)) {
          dedup.set(emailLower, {
            email: u.email,
            name: u.name,
            role: u.role,
            assignedVillageId: u.assignedVillageId
          });
        }
      }

      const finalRecipients = Array.from(dedup.values());
      return await sendToList(finalRecipients);

    } catch (error) {
      console.error('❌ Error in notification email automation:', error);
      throw error;
    }
  }

  shouldUserReceiveNotificationEmail(user, notification) {
    // Don't send email to the user who performed the action
    if (user.email === notification.performedBy) {
      return false;
    }

    // Check user role and permissions
    const userRole = user.role;
    const userPermissions = user.permissions || {};

    switch (userRole) {
      case 'main':
        // Main admin receives all notifications
        return true;

      case 'secondary':
        if (user.assignedVillageId) {
          // Secondary admin with village - receives notifications related to their village
          return notification.villageId === user.assignedVillageId || 
                 userPermissions.notifications === true;
        } else {
          // Secondary admin without village - receives notifications if they have permission
          return userPermissions.notifications === true;
        }

      case 'village_editor':
        // Village editor receives notifications related to their assigned village
        return user.assignedVillageId && 
               notification.villageId === user.assignedVillageId;

      default:
        return false;
    }
  }

  getUserRoleForEmail(user) {
    if (user.role === 'secondary' && user.assignedVillageId) {
      return 'secondary_with_village';
    }
    return user.role;
  }
}

module.exports = NotificationEmailService;