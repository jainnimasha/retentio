document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('scorecard-form');
  if (!form) return;

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

  var TIERS = [
    { max: 5, label: 'Not Ready' },
    { max: 10, label: 'Nurture' },
    { max: 15, label: 'Ready to Activate' }
  ];
  function getTierLabel(score) {
    for (var i = 0; i < TIERS.length; i++) { if (score <= TIERS[i].max) return TIERS[i].label; }
    return TIERS[TIERS.length - 1].label;
  }

  var collected = null;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var tenure = parseInt(form.querySelector('input[name="tenure"]:checked').value, 10);
    var usage = parseInt(form.querySelector('input[name="usage"]:checked').value, 10);
    var sentiment = parseInt(form.querySelector('input[name="sentiment"]:checked').value, 10);
    var arr = form.querySelector('input[name="arr"]:checked').value;

    var engagementLabels = [];
    form.querySelectorAll('input[name="engagement"]:checked').forEach(function (el) {
      engagementLabels.push(el.closest('.tile-option').querySelector('.tile-label').textContent);
    });

    var total = tenure + usage + sentiment + engagementLabels.length;

    collected = {
      tenure_label: form.querySelector('input[name="tenure"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      usage_label: form.querySelector('input[name="usage"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      sentiment_label: form.querySelector('input[name="sentiment"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      arr: arr,
      engagement_signals: engagementLabels,
      score: total,
      tier: getTierLabel(total)
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
      otpStatus.textContent = 'Your answers got reset (maybe the page reloaded). Please click Reset and start over.';
      otpStatus.setAttribute('data-state', 'error');
      return;
    }

    var submitBtn = otpForm.querySelector('.tool-submit');
    submitBtn.disabled = true;
    otpStatus.textContent = 'Verifying and building your Champion Program recommendation…';
    otpStatus.setAttribute('data-state', 'loading');

    var payload = Object.assign({}, collected, {
      email: document.getElementById('lead-email').value.trim(),
      phone: document.getElementById('lead-phone').value.trim(),
      otp: otpInput.value.trim()
    });

    fetch('/api/champion-scorecard', {
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
        var tierClass = collected.tier === 'Not Ready' ? 'tool-tier-not-ready' : (collected.tier === 'Nurture' ? 'tool-tier-nurture' : 'tool-tier-ready');
        finalEl.innerHTML =
          '<span class="tool-tier ' + tierClass + '">' + collected.tier + '</span>' +
          '<p class="tool-score">' + collected.score + ' / 15 points</p>' +
          '<div class="tool-final-body">' + data.recommendation + '</div>';
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
    leadgateForm.hidden = true;
    otpForm.hidden = true;
    alreadyLeadForm.hidden = true;
    finalEl.hidden = true;
    finalEl.innerHTML = '';
    leadStatus.textContent = '';
    leadStatus.removeAttribute('data-state');
    otpStatus.textContent = '';
    otpStatus.removeAttribute('data-state');
    collected = null;
    placeholder.hidden = false;
  });
});
