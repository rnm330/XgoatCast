// Export the same template used by the running server for Tencent SES upload.
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { VERIFICATION_EMAIL_TEMPLATE } = require('../server/dist/modules/panels/email-template.js');
writeFileSync(resolve(__dirname, '../docs/ses-email-template.html'), VERIFICATION_EMAIL_TEMPLATE);
