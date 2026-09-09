/* Notifications wrapper.
   Depends on:
     - veloSecurityDoPost_(e)   (defined in SecurityOverrides.gs)
     - handleAdminGetApplication (defined in Code.gs)
     - getSheet_, getSpreadsheet_, dateValue_, safeErrorMessage_,
       jsonOut_, normalizeEmail_, uniqueNonEmpty_  (defined in Code.gs)
   doPost lives ONLY here, so there's no hoisting/assignment war. */

function escapeHtml_(value){
  return String(value==null?'':value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function veloNotifyEmail_(to,name,subject,html){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('BREVO_API_KEY');
  if(!key || !to) return;
  var base       = props.getProperty('BREVO_BASE_URL')    || 'https://api.brevo.com';
  var senderEmail= props.getProperty('BREVO_SENDER_EMAIL')|| 'noreply@quantigrate.com';
  var senderName = props.getProperty('BREVO_SENDER_NAME') || 'Velo Finance LTD';
  var r = UrlFetchApp.fetch(base + '/v3/smtp/email', {
    method:'post',
    contentType:'application/json',
    muteHttpExceptions:true,
    headers:{ accept:'application/json','api-key':key },
    payload: JSON.stringify({
      sender:{ email:senderEmail, name:senderName },
      to:[{ email: String(to).trim().toLowerCase(), name:name||'' }],
      subject:subject,
      htmlContent:html
    })
  });
  if(r.getResponseCode()<200 || r.getResponseCode()>=300){
    console.warn('Brevo notification failed: ' + r.getContentText().slice(0,300));
  }
}

function veloNotifyRecipients_(){
  var p = PropertiesService.getScriptProperties(), c = {};
  try { c = JSON.parse(p.getProperty('VELO_ADMIN_CONFIG') || '{}'); } catch(_){}
  var list = [];
  if(Array.isArray(c.adminEmails))         list = list.concat(c.adminEmails);
  if(Array.isArray(c.loanManagerEmails))   list = list.concat(c.loanManagerEmails);
  var a = p.getProperty('VELO_ADMIN_EMAIL');
  if(a) list.push(a);
  return uniqueNonEmpty_(list.map(normalizeEmail_));
}

function veloApplication_(id){
  var r = handleAdminGetApplication({ applicationId:id });
  return r && r.ok ? r.application : null;
}

function veloNotifyApplication_(app, subjectPrefix){
  if(!app) return;
  var name = (app.applicantType==='BUSINESS'
      ? (app.businessInfo && app.businessInfo.businessName)
      : (app.personalInfo && app.personalInfo.fullName)) || 'Applicant';
  var to = normalizeEmail_(
    app.applicantType==='BUSINESS'
      ? (app.businessRep && app.businessRep.email) || (app.personalInfo && app.personalInfo.email)
      : (app.personalInfo && app.personalInfo.email)
  );
  var subject = subjectPrefix + ' — ' + app.applicationId;
  var html =
    '<h2>Velo Finance loan application update</h2>' +
    '<p>Hello ' + escapeHtml_(name) + ',</p>' +
    '<p>Your application <strong>' + escapeHtml_(app.applicationId) + '</strong> has been updated.</p>' +
    '<p>Status: <strong>' + escapeHtml_(app.status||'') + '</strong><br>' +
    'Loan amount: <strong>₦' + Number(app.loan && app.loan.amount || 0).toLocaleString('en-NG') + '</strong><br>' +
    'Repayment date: <strong>' + escapeHtml_((app.loan && app.loan.repaymentDate) || '—') + '</strong></p>' +
    '<p>Velo Finance LTD</p>';
  if(to) veloNotifyEmail_(to, name, subject, html);
  veloNotifyRecipients_().forEach(function(e){
    veloNotifyEmail_(e, 'Velo Finance Admin', subject, html);
  });
}

function veloCleanupDrafts_(){
  var sheet = getSheet_(getSpreadsheet_());
  var last  = sheet.getLastRow();
  if(last < 2) return;
  var h  = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  var si = h.indexOf('Application Status');
  var ui = h.indexOf('Date Last Updated');
  if(si<0 || ui<0) return;
  var rows = sheet.getRange(2,1,last-1,sheet.getLastColumn()).getValues();
  var cut  = Date.now() - 24*60*60*1000;
  var remove = [];
  rows.forEach(function(r,i){
    var s = String(r[si]||'').toUpperCase();
    var d = dateValue_(r[ui]);
    if((s==='DRAFT' || s==='IN_PROGRESS') && d && d<cut) remove.push(i+2);
  });
  remove.reverse().forEach(function(r){ sheet.deleteRow(r); });
}

/* Single, authoritative doPost. */
function doPost(e){
  try {
    if(!e || !e.postData || !e.postData.contents){
      return jsonOut_({ ok:false, error:'Empty request body.' });
    }
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch(_) { return jsonOut_({ ok:false, error:'Invalid JSON request body.' }); }

    var a = String(body.action || '');
    var p = body.payload || {};

    if(a==='saveDraft' || a==='requestResumeOtp' || a==='verifyResumeOtp'){
      veloCleanupDrafts_();
    }

    var out = veloSecurityDoPost_(e);

    // Best-effort notifications — never block the response.
    try {
      var content = out && out.getContent ? out.getContent() : '{}';
      var result  = {};
      try { result = JSON.parse(content); } catch(_){}
      if(result && result.ok){
        if(a==='adminUpdateStatus'){
          veloNotifyApplication_(veloApplication_(p.applicationId),
            'Velo Finance application status update');
        } else if(a==='submit' && result.applicationId){
          veloNotifyApplication_(veloApplication_(result.applicationId),
            'Velo Finance application submitted');
        }
        // adminCreateLoanManager notifications are sent inside VeloSecurity.createManager
      }
    } catch(notificationError){
      console.warn('Loan notification failed: ' + safeErrorMessage_(notificationError));
    }

    return out;
  } catch(err){
    console.error(err && err.stack ? err.stack : err);
    return jsonOut_({ ok:false, error: safeErrorMessage_(err) });
  }
}