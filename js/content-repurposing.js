document.addEventListener('DOMContentLoaded', function () {
  var WORD_CAP = 2000;

  var form = document.getElementById('content-form');
  if (!form) return;

  var textarea = document.getElementById('content-text');
  var wordCountEl = document.getElementById('word-count');
  var placeholder = document.getElementById('tool-placeholder');
  var leadgateForm = document.getElementById('tool-leadgate');
  var leadStatus = document.getElementById('lead-status');
  var otpForm = document.getElementById('tool-otp-form');
  var otpStatus = document.getElementById('otp-status');
  var resendBtn = document.getElementById('resend-btn');
  var alreadyLeadForm = document.getElementById('already-lead-form');
  var alreadyLeadMessage = document.getElementById('already-lead-message');
  var finalEl = document.getElementById('tool-final');
  var resetBtn = document.getElementById('tool-reset');

  var collected = null;

  document.querySelectorAll('.check-option').forEach(function (label) {
    var input = label.querySelector('input');
    input.addEventListener('change', function () {
      label.classList.toggle('checked', input.checked);
    });
  });

  function wordCount(text) {
    var trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  textarea.addEventListener('input', function () {
    var count = wordCount(textarea.value);
    wordCountEl.textContent = count + ' / ' + WORD_CAP + ' words';
    wordCountEl.classList.toggle('over', count > WORD_CAP);
  });

  function checkedValues(containerId) {
    return Array.prototype.slice.call(document.querySelectorAll('#' + containerId + ' input:checked')).map(function (el) { return el.value; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var text = textarea.value.trim();
    var count = wordCount(text);

    if (!text) {
      wordCountEl.textContent = 'Please paste some content first.';
      wordCountEl.classList.add('over');
      textarea.focus();
      return;
    }
    if (count > WORD_CAP) {
      wordCountEl.textContent = 'Please trim to ' + WORD_CAP + ' words or fewer (currently ' + count + ').';
      wordCountEl.classList.add('over');
      textarea.focus();
      return;
    }

    collected = {
      contentType: document.getElementById('content-type').value,
      text: text,
      audiences: checkedValues('audience-checks'),
      goals: checkedValues('goal-checks')
    };

    placeholder.hidden = true;
    finalEl.hidden = true;
    otpForm.hidden = true;
    alreadyLeadForm.hidden = true;
    leadgateForm.hidden = false;
    leadStatus.textContent = '';
    leadStatus.removeAttribute('data-state');
  });

  function sendOtp(email, statusEl, btn) {
    btn.disabled = true;
    statusEl.textContent = 'Sending code…';
    statusEl.setAttribute('data-state', 'loading');

    return fetch('/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Request failed');
          return data;
        });
      })
      .then(function (data) {
        statusEl.textContent = '';
        statusEl.removeAttribute('data-state');
        return data;
      })
      .catch(function (err) {
        statusEl.textContent = err.message || 'Could not send a code right now. Please try again.';
        statusEl.setAttribute('data-state', 'error');
        return { ok: false };
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  leadgateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var emailInput = document.getElementById('lead-email');
    if (!emailInput.value || !emailInput.validity.valid) {
      leadStatus.textContent = 'Please enter a valid work email.';
      leadStatus.setAttribute('data-state', 'error');
      emailInput.focus();
      return;
    }
    var btn = document.getElementById('send-otp-btn');
    sendOtp(emailInput.value.trim(), leadStatus, btn).then(function (data) {
      if (data.alreadyLead) {
        leadgateForm.hidden = true;
        alreadyLeadMessage.textContent = data.message || "We've already got your details on file.";
        alreadyLeadForm.hidden = false;
        return;
      }
      if (data.ok) {
        leadgateForm.hidden = true;
        otpForm.hidden = false;
        document.getElementById('otp-code').focus();
      }
    });
  });

  resendBtn.addEventListener('click', function () {
    var email = document.getElementById('lead-email').value.trim();
    sendOtp(email, otpStatus, resendBtn).then(function (data) {
      if (data.alreadyLead) {
        otpForm.hidden = true;
        alreadyLeadMessage.textContent = data.message || "We've already got your details on file.";
        alreadyLeadForm.hidden = false;
        return;
      }
      if (data.ok) {
        otpStatus.textContent = 'A new code is on its way.';
        otpStatus.setAttribute('data-state', 'success');
      }
    });
  });

  otpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var otpInput = document.getElementById('otp-code');
    if (!otpInput.value || otpInput.value.length !== 6) {
      otpStatus.textContent = 'Enter the 6-digit code from your email.';
      otpStatus.setAttribute('data-state', 'error');
      otpInput.focus();
      return;
    }
    if (!collected) {
      otpStatus.textContent = 'Your content got reset (maybe the page reloaded). Please click Reset and start over.';
      otpStatus.setAttribute('data-state', 'error');
      return;
    }

    var submitBtn = otpForm.querySelector('.tool-submit');
    submitBtn.disabled = true;
    otpStatus.textContent = 'Verifying and analyzing your content…';
    otpStatus.setAttribute('data-state', 'loading');

    var payload = {
      email: document.getElementById('lead-email').value.trim(),
      phone: document.getElementById('lead-phone').value.trim(),
      otp: otpInput.value.trim(),
      content_type: collected.contentType,
      content_text: collected.text,
      audiences: collected.audiences,
      goals: collected.goals
    };

    fetch('/api/content-repurposing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Request failed');
          return data;
        });
      })
      .then(function (data) {
        otpForm.hidden = true;
        finalEl.hidden = false;

        var tierClass = data.tier === 'Not Ready' ? 'tier-low' : (data.tier === 'Good Potential' ? 'tier-mid' : 'tier-high');
        var fitTagsHtml = data.formats.map(function (f) { return '<span class="fit-tag">' + f + '</span>'; }).join('');

        finalEl.innerHTML =
          '<span class="tier-badge ' + tierClass + '">' + data.tier + '</span>' +
          '<div style="font-size:13px;font-weight:700;color:var(--muted)">Readiness score: ' + data.score + ' / 10</div>' +
          '<div class="fit-formats">' + fitTagsHtml + '</div>' +
          '<div class="tool-final-body">' + data.explanation + '</div>' +
          '<div class="cta-block">' +
            '<p>Want this actually repurposed, not just scored? We do this as a hands-on content service — you send us the raw material, we turn it into finished, channel-ready content.</p>' +
            '<a class="tool-submit" href="contact.html">Talk to us about content services →</a>' +
          '</div>';
      })
      .catch(function (err) {
        otpStatus.textContent = err.message || 'That code didn\u2019t work. Please try again or resend a new code.';
        otpStatus.setAttribute('data-state', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });

  resetBtn.addEventListener('click', function () {
    form.reset();
    leadgateForm.reset();
    otpForm.reset();
    document.querySelectorAll('.check-option').forEach(function (l) { l.classList.remove('checked'); });
    leadgateForm.hidden = true;
    otpForm.hidden = true;
    alreadyLeadForm.hidden = true;
    finalEl.hidden = true;
    finalEl.innerHTML = '';
    leadStatus.textContent = '';
    leadStatus.removeAttribute('data-state');
    otpStatus.textContent = '';
    otpStatus.removeAttribute('data-state');
    wordCountEl.textContent = '0 / ' + WORD_CAP + ' words';
    wordCountEl.classList.remove('over');
    collected = null;
    placeholder.hidden = false;
  });
});
