var SERVER = 'https://email-tracker-em6b.onrender.com';
var isLoggedIn = false;
var trackingStates = {};

var loginIntervalId;
var composeIntervalId;

function init() {
  checkLogin();
  watchCompose();
  loginIntervalId = setInterval(checkLogin, 500);
}

function checkLogin() {
  if (!chrome.runtime || !chrome.runtime.id) {
    clearInterval(loginIntervalId);
    clearInterval(composeIntervalId);
    return; 
  }

  chrome.storage.local.get('mailpulse_token', function(data) {
    if (chrome.runtime.lastError) return; 
    
    var hasToken = !!(data && data.mailpulse_token);
    if (hasToken != isLoggedIn) {
      isLoggedIn = hasToken;
      updateButtons();
    }
  });
}

function updateButtons() {
  var buttons = document.querySelectorAll('.mailpulse-btn');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].remove();
  }
  
  setTimeout(function() {
    var composes = document.querySelectorAll('.AD');
    for (var j = 0; j < composes.length; j++) {
      if (composes[j].getAttribute('data-mailpulse-id')) {
        addButton(composes[j]);
      }
    }
  }, 100);
}

function generateUUID() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function watchCompose() {
  composeIntervalId = setInterval(function() {
    var composes = document.querySelectorAll('.AD');
    for (var i = 0; i < composes.length; i++) {
      var id = composes[i].getAttribute('data-mailpulse-id');
      if (!id) {
        id = generateUUID();
        composes[i].setAttribute('data-mailpulse-id', id);
        trackingStates[id] = true;
        addButton(composes[i]);
        injectPixel(composes[i], id);
      }
    }
  }, 600);
}

function injectPixel(win, id) {
  var body = win.querySelector('[contenteditable="true"]');
  if (!body) return;
  
  var existing = body.querySelector('#mp-pixel-' + id);
  
  if (trackingStates[id]) {
    if (!existing) {
      var img = document.createElement('img');
      img.id = 'mp-pixel-' + id;
      img.src = SERVER + '/track/pixel/' + id + '?role=unknown';
      img.style.cssText = 'width:1px;height:1px;display:none!important;opacity:0;';
      body.appendChild(img);
    }
  } else {
    if (existing) {
      existing.remove();
    }
  }
}

function addButton(win) {
  try {
    var id = win.getAttribute('data-mailpulse-id');
    if (!id) return;
    
    var toolbar = win.querySelector('.btC');
    if (!toolbar) return;
    
    var old = toolbar.querySelector('.mailpulse-btn');
    if (old) old.remove();

    var btn = document.createElement('div');
    
    if (isLoggedIn) {
      var isOn = trackingStates[id];
      
      btn.className = 'mailpulse-btn ' + (isOn ? 'mailpulse-active' : 'mailpulse-off');
      btn.innerHTML = '<span class="mailpulse-dot"></span> ' + (isOn ? 'Tracking ON' : 'Tracking OFF');
      
      btn.onclick = function() {
        trackingStates[id] = !trackingStates[id];
        injectPixel(win, id);
        addButton(win);
      };

      if (!win.getAttribute('data-mp-hooked')) {
         var sendBtn = win.querySelector('[data-tooltip^="Send"]') || win.querySelector('[aria-label*="Send"]') || win.querySelector('.dC');
         if (sendBtn) {
           sendBtn.addEventListener('mousedown', function() {
             if (trackingStates[id]) {
               executeRegistration(win, id);
             }
           });
         }

         win.addEventListener('keydown', function(e) {
             if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                 if (trackingStates[id]) {
                   executeRegistration(win, id);
                 }
             }
         }, true);

         win.setAttribute('data-mp-hooked', 'true');
      }
    } else {
      btn.className = 'mailpulse-btn mailpulse-warning';
      btn.innerHTML = '<span class="mailpulse-dot"></span> LOGIN';
      btn.onclick = function() { window.open(SERVER); };
    }
    
    toolbar.appendChild(btn);
  } catch(e) {
    console.log('Error', e);
  }
}

function executeRegistration(win, id) {
  var subjectBox = win.querySelector('[name="subjectbox"]');
  var subject = subjectBox ? subjectBox.value : '(No Subject)';
  
  var toEmails = getEmails(win, 'to');
  var ccEmails = getEmails(win, 'cc');
  var bccEmails = getEmails(win, 'bcc');

  var recipients = [];
  for (var i = 0; i < toEmails.length; i++) {
    recipients.push({ email: toEmails[i], role: 'to' });
  }
  for (var j = 0; j < ccEmails.length; j++) {
    recipients.push({ email: ccEmails[j], role: 'cc' });
  }
  for (var k = 0; k < bccEmails.length; k++) {
    recipients.push({ email: bccEmails[k], role: 'bcc' });
  }

  if (recipients.length === 0) return;

  if (recipients.length === 1) {
    var body = win.querySelector('[contenteditable="true"]');
    if (body) {
      var pixelImg = body.querySelector('#mp-pixel-' + id);
      if (pixelImg) {
        pixelImg.src = SERVER + '/track/pixel/' + id + '?r=' + encodeURIComponent(recipients[0].email) + '&role=' + recipients[0].role;
      }
    }
  }

  if (!chrome.runtime || !chrome.runtime.id) {
    return; 
  }

  chrome.storage.local.get('mailpulse_token', function(data) {
    if (chrome.runtime.lastError) return;
    
    var token = data ? data.mailpulse_token : null;
    if (!token) return;

    fetch(SERVER + '/api/track/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ trackingId: id, subject: subject, recipients: recipients })
    }).catch(function(err) {
      console.log('MailPulse Registration Error:', err);
    });
  });
}

function getEmails(win, field) {
  var emails = [];
  var elements = win.querySelectorAll('[aria-label]');
  for (var i = 0; i < elements.length; i++) {
    var label = elements[i].getAttribute('aria-label');
    if (label && label.toLowerCase().indexOf(field) > -1) {
      var text = elements[i].textContent;
      var matches = text.match(/[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (matches) {
        for (var j = 0; j < matches.length; j++) {
          if (emails.indexOf(matches[j]) < 0) {
            emails.push(matches[j]);
          }
        }
      }
    }
  }
  return emails;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}