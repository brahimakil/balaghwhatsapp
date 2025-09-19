const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.fromEmail = process.env.SUPPORT_EMAIL || 'balaghlbsupport@gmail.com';
    this.setupTransporter();
  }

  setupTransporter() {
    try {
      console.log('📧 Setting up email transporter...');
      
      // Replace the debugging section (around line 16-18) with more detailed output
      console.log('📧 Email config check:');
      console.log('- SUPPORT_EMAIL:', process.env.SUPPORT_EMAIL);
      console.log('- SUPPORT_EMAIL_PASSWORD:', process.env.SUPPORT_EMAIL_PASSWORD);
      console.log('- Email length:', process.env.SUPPORT_EMAIL ? process.env.SUPPORT_EMAIL.length : 'undefined');
      console.log('- Password length:', process.env.SUPPORT_EMAIL_PASSWORD ? process.env.SUPPORT_EMAIL_PASSWORD.length : 'undefined');
      console.log('- Working directory:', process.cwd());

      // Check if environment variables are set
      if (!process.env.SUPPORT_EMAIL || !process.env.SUPPORT_EMAIL_PASSWORD) {
        console.error('❌ Email environment variables not set. Please add SUPPORT_EMAIL and SUPPORT_EMAIL_PASSWORD to .env');
        return;
      }

      // Update the transporter configuration to use a more reliable SMTP
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // Use SSL
        auth: {
          user: process.env.SUPPORT_EMAIL,
          pass: process.env.SUPPORT_EMAIL_PASSWORD
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      console.log('✅ Email transporter configured successfully');
      this.initialized = true;
      
    } catch (error) {
      console.error('❌ Error setting up email transporter:', error);
      this.initialized = false;
    }
  }

  async testConnection() {
    if (!this.initialized) {
      throw new Error('Email service not initialized. Check environment variables.');
    }

    try {
      console.log('🔍 Testing email connection...');
      await this.transporter.verify();
      console.log('✅ Email connection test successful');
      return { success: true, message: 'Email connection is working' };
    } catch (error) {
      console.error('❌ Email connection test failed:', error);
      throw new Error(`Email connection failed: ${error.message}`);
    }
  }

  async sendTestEmail(toEmail, testMessage = 'This is a test email from Balagh notification system') {
    if (!this.initialized) {
      throw new Error('Email service not initialized. Check environment variables.');
    }

    try {
      console.log(`📧 Sending test email to: ${toEmail}`);

      const mailOptions = {
        from: `"Balagh Support" <${this.fromEmail}>`,
        to: toEmail,
        subject: '🧪 Test Email - Balagh Notification System',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">🧪 Test Email</h1>
              <p style="color: white; margin: 5px 0 0 0;">Balagh Notification System</p>
            </div>
            <div style="padding: 20px; background: #f9f9f9;">
              <h2 style="color: #333;">Test Successful!</h2>
              <p style="color: #666; line-height: 1.6;">
                ${testMessage}
              </p>
              <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <h3 style="margin: 0 0 10px 0; color: #333;">Test Details:</h3>
                <p style="margin: 5px 0; color: #666;"><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
                <p style="margin: 5px 0; color: #666;"><strong>To:</strong> ${toEmail}</p>
                <p style="margin: 5px 0; color: #666;"><strong>From:</strong> ${this.fromEmail}</p>
              </div>
              <p style="color: #666; font-size: 14px; margin-top: 30px;">
                If you receive this email, the notification system is working correctly!
              </p>
            </div>
            <div style="background: #333; padding: 15px; text-align: center;">
              <p style="color: #999; margin: 0; font-size: 12px;">
                © 2024 Balagh Admin System - Notification Service
              </p>
            </div>
          </div>
        `
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Test email sent successfully:', result.messageId);
      
      return {
        success: true,
        messageId: result.messageId,
        message: `Test email sent successfully to ${toEmail}`
      };

    } catch (error) {
      console.error('❌ Error sending test email:', error);
      throw new Error(`Failed to send test email: ${error.message}`);
    }
  }

  async sendNotificationEmail(toEmail, notification) {
    if (!this.initialized) {
      throw new Error('Email service not initialized. Check environment variables.');
    }

    try {
      console.log(`📧 Sending notification email to: ${toEmail}`);

      const mailOptions = {
        from: `"Balagh Notifications" <${this.fromEmail}>`,
        to: toEmail,
        subject: `🔔 New Notification - ${notification.titleEn || 'Balagh Admin'}`,
        html: this.generateNotificationEmailTemplate(notification)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Notification email sent successfully:', result.messageId);
      
      return {
        success: true,
        messageId: result.messageId,
        message: `Notification email sent successfully to ${toEmail}`
      };

    } catch (error) {
      console.error('❌ Error sending notification email:', error);
      throw new Error(`Failed to send notification email: ${error.message}`);
    }
  }

  async sendNotificationEmailToUser(userEmail, notification, recipientRole, recipientName) {
    if (!this.initialized) {
      throw new Error('Email service not initialized. Check environment variables.');
    }

    try {
      console.log(`📧 Sending notification email to ${recipientRole}: ${userEmail}`);

      const mailOptions = {
        from: `"Balagh Notifications" <${this.fromEmail}>`,
        to: userEmail,
        subject: `🔔 New ${this.getActionDisplayName(notification.action)} - ${notification.entityName}`,
        html: this.generateUserNotificationEmailTemplate(notification, recipientRole, recipientName)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Notification email sent successfully:', result.messageId);
      
      return {
        success: true,
        messageId: result.messageId,
        message: `Notification email sent successfully to ${userEmail}`
      };

    } catch (error) {
      console.error('❌ Error sending notification email:', error);
      throw new Error(`Failed to send notification email: ${error.message}`);
    }
  }

  generateNotificationEmailTemplate(notification) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">🔔 New Notification</h1>
          <p style="color: white; margin: 5px 0 0 0;">Balagh Admin System</p>
        </div>
        <div style="padding: 20px; background: #f9f9f9;">
          <div style="background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea;">
            <h2 style="margin: 0 0 15px 0; color: #333;">${notification.titleEn || 'Notification'}</h2>
            ${notification.titleAr ? `<h3 style="margin: 0 0 15px 0; color: #666; direction: rtl;">${notification.titleAr}</h3>` : ''}
            
            <div style="margin: 15px 0;">
              <p style="color: #666; line-height: 1.6; margin: 0;">
                ${notification.messageEn || notification.message || 'You have received a new notification.'}
              </p>
              ${notification.messageAr ? `<p style="color: #666; line-height: 1.6; margin: 10px 0 0 0; direction: rtl;">${notification.messageAr}</p>` : ''}
            </div>

            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h4 style="margin: 0 0 10px 0; color: #333;">Notification Details:</h4>
              <p style="margin: 5px 0; color: #666;"><strong>Type:</strong> ${notification.type || 'General'}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
              ${notification.priority ? `<p style="margin: 5px 0; color: #666;"><strong>Priority:</strong> ${notification.priority}</p>` : ''}
            </div>

            <div style="text-align: center; margin: 25px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/notifications" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                View in Admin Panel
              </a>
            </div>
          </div>
        </div>
        <div style="background: #333; padding: 15px; text-align: center;">
          <p style="color: #999; margin: 0; font-size: 12px;">
            © 2024 Balagh Admin System - You received this because you have notifications enabled
          </p>
        </div>
      </div>
    `;
  }

  getActionDisplayName(action) {
    const actionMap = {
      'created': 'Creation',
      'updated': 'Update', 
      'deleted': 'Deletion',
      'approved': 'Approval',
      'rejected': 'Rejection'
    };
    return actionMap[action] || action;
  }

  getRoleDisplayName(role) {
    const roleMap = {
      'main': 'Main Administrator',
      'secondary': 'Secondary Administrator', 
      'village_editor': 'Village Editor',
      'secondary_with_village': 'Village Secondary Administrator'
    };
    return roleMap[role] || role;
  }

  getEntityDisplayName(entityType) {
    const entityMap = {
      'martyrs': 'Martyr',
      'locations': 'Location',
      'legends': 'Legend',
      'activities': 'Activity', 
      'activityTypes': 'Activity Type',
      'news': 'News',
      'liveNews': 'Live News',
      'admins': 'Administrator'
    };
    return entityMap[entityType] || entityType;
  }

  generateUserNotificationEmailTemplate(notification, recipientRole, recipientName) {
    const actionDisplay = this.getActionDisplayName(notification.action);
    const entityDisplay = this.getEntityDisplayName(notification.entityType);
    const roleDisplay = this.getRoleDisplayName(recipientRole);
    
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">🔔 New Notification</h1>
          <p style="color: white; margin: 5px 0 0 0;">Balagh Admin System</p>
        </div>
        <div style="padding: 20px; background: #f9f9f9;">
          <div style="background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea;">
            <h2 style="margin: 0 0 15px 0; color: #333;">Hello ${recipientName || 'Administrator'},</h2>
            
            <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
              A new ${actionDisplay.toLowerCase()} has occurred in the system that requires your attention.
            </p>

            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin: 0 0 15px 0; color: #333;">📋 Notification Details</h3>
              <p style="margin: 5px 0; color: #666;"><strong>Action:</strong> ${entityDisplay} ${actionDisplay}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Entity:</strong> ${notification.entityName}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Performed by:</strong> ${notification.performedByName || notification.performedBy}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Time:</strong> ${new Date().toLocaleString()}</p>
              ${notification.details ? `<p style="margin: 5px 0; color: #666;"><strong>Details:</strong> ${notification.details}</p>` : ''}
              ${notification.villageId ? `<p style="margin: 5px 0; color: #666;"><strong>Village:</strong> ${notification.villageId}</p>` : ''}
            </div>

            <div style="background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h4 style="margin: 0 0 10px 0; color: #1976d2;">👤 Your Role</h4>
              <p style="margin: 0; color: #666;">You are receiving this notification as a <strong>${roleDisplay}</strong> in the Balagh Admin System.</p>
            </div>

            <div style="text-align: center; margin: 25px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/notifications" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 0 10px 10px 0;">
                📋 View Notifications
              </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/dashboard" 
                 style="background: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 0 10px 10px 0;">
                🏠 Go to Dashboard
              </a>
            </div>

             
          </div>
        </div>
        <div style="background: #333; padding: 15px; text-align: center;">
          <p style="color: #999; margin: 0; font-size: 12px;">
            © 2024 Balagh Admin System - You received this because you have notification permissions<br>
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/settings" style="color: #999;">Manage Email Preferences</a>
          </p>
        </div>
      </div>
    `;
  }
}

module.exports = EmailService;
