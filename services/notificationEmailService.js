const { getDb } = require('../config/firebase');

class NotificationEmailService {
  constructor(emailService) {
    this.emailService = emailService;
    this.db = getDb();
  }

  async sendNotificationEmails(notification) {
    try {
      console.log('🔔 Processing notification for email automation:', notification);
      
      // Get all users to determine who should receive emails
      const usersSnapshot = await this.db.collection('users').get();
      const allUsers = usersSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      const emailPromises = [];

      for (const user of allUsers) {
        try {
          const shouldReceiveEmail = this.shouldUserReceiveNotificationEmail(user, notification);
          
          if (shouldReceiveEmail) {
            console.log(`📧 Sending notification email to ${user.role}: ${user.email}`);
            
            const emailPromise = this.emailService.sendNotificationEmailToUser(
              user.email,
              notification,
              this.getUserRoleForEmail(user),
              user.name
            ).catch(error => {
              console.error(`❌ Failed to send email to ${user.email}:`, error.message);
              return { success: false, email: user.email, error: error.message };
            });
            
            emailPromises.push(emailPromise);
          }
        } catch (error) {
          console.error(`❌ Error processing user ${user.email}:`, error.message);
        }
      }

      if (emailPromises.length > 0) {
        console.log(`📬 Sending ${emailPromises.length} notification emails...`);
        const results = [];
        for (let i = 0; i < emailPromises.length; i++) {
          console.log(`📧 Sending email ${i + 1}/${emailPromises.length}...`);
          const result = await emailPromises[i];
          results.push(result);
          
          // Add 2 second delay between emails to avoid rate limiting
          if (i < emailPromises.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        console.log(`✅ Email automation completed: ${successful} sent, ${failed} failed`);
        return { successful, failed, total: emailPromises.length };
      } else {
        console.log('📭 No users need to receive email for this notification');
        return { successful: 0, failed: 0, total: 0 };
      }

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