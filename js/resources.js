document.addEventListener('DOMContentLoaded', function () {

  var scorecardForm = document.getElementById('scorecard-form');
  if (!scorecardForm) return;

  var placeholderEl = document.getElementById('scorecard-placeholder');
  var leadgateForm = document.getElementById('scorecard-leadgate');
  var leadStatusEl = document.getElementById('scorecard-lead-status');
  var otpForm = document.getElementById('scorecard-otp-form');
  var otpStatusEl = document.getElementById('scorecard-otp-status');
  var resendOtpBtn = document.getElementById('scorecard-resend-otp');
  var finalEl = document.getElementById('scorecard-final');
  var resetBtn = document.getElementById('scorecard-reset');

  var TIERS = [
    { max: 6, label: 'Not Ready' },
    { max: 12, label: 'Nurture' },
    { max: 18, label: 'Ready to Activate' }
  ];

  function getTierLabel(score) {
    for (var i = 0; i < TIERS.length; i++) {
      if (score <= TIERS[i].max) return TIERS[i].label;
    }
    return TIERS[TIERS.length - 1].label;
  }

  var collectedInputs = null;

  scorecardForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var tenure = parseInt(scorecardForm.querySelector('input[name="tenure"]:checked').value, 10);
    var usage = parseInt(scorecardForm.querySelector('input[name="usage"]:checked').value, 10);
    var sentiment = parseInt(scorecardForm.querySelector('input[name="sentiment"]:checked').value, 10);
    var seniority = parseInt(scorecardForm.querySelector('input[name="seniority"]:checked').value, 10);
    var arr = scorecardForm.querySelector('input[name="arr"]:checked').value;

    var engagementLabels = [];
    scorecardForm.querySelectorAll('input[name="engagement"]:checked').forEach(function (el) {
      engagementLabels.push(el.closest('.tile-option').querySelector('.tile-label').textContent);
    });

    var total = tenure + usage + sentiment + seniority + engagementLabels.length;

    collectedInputs = {
      tenure_label: scorecardForm.querySelector('input[name="tenure"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      usage_label: scorecardForm.querySelector('input[name="usage"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      sentiment_label: scorecardForm.querySelector('input[name="sentiment"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      seniority_label: scorecardForm.querySelector('input[name="seniority"]:checked').closest('.tile-option').querySelector('.tile-label').textContent,
      arr: arr,
      engagement_signals: engagementLabels,
      score: total,
      tier: getTierLabel(total)
    };

    placeholderEl.hidden = true;
    finalEl.hidden = true;
    otpForm.hidden = true;
    leadgateForm.hidden = false;
    leadStatusEl.textContent = '';
    leadStatusEl.removeAttribute('data-state');
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
      .then(function () {
        statusEl.textContent = '';
        statusEl.removeAttribute('data-state');
        return true;
      })
      .catch(function (err) {
        statusEl.textContent = err.message || 'Could not send a code right now. Please try again.';
        statusEl.setAttribute('data-state', 'error');
        return false;
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  leadgateForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var emailInput = document.getElementById('lead-email');
    if (!emailInput.value || !emailInput.validity.valid) {
      leadStatusEl.textContent = 'Please enter a valid work email.';
      leadStatusEl.setAttribute('data-state', 'error');
      emailInput.focus();
      return;
    }

    var sendBtn = document.getElementById('scorecard-send-otp-btn');
    sendOtp(emailInput.value.trim(), leadStatusEl, sendBtn).then(function (ok) {
      if (ok) {
        leadgateForm.hidden = true;
        otpForm.hidden = false;
        document.getElementById('otp-code').focus();
      }
    });
  });

  resendOtpBtn.addEventListener('click', function () {
    var email = document.getElementById('lead-email').value.trim();
    sendOtp(email, otpStatusEl, resendOtpBtn).then(function (ok) {
      if (ok) {
        otpStatusEl.textContent = 'A new code is on its way.';
        otpStatusEl.setAttribute('data-state', 'success');
      }
    });
  });

  otpForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var otpInput = document.getElementById('otp-code');
    if (!otpInput.value || otpInput.value.length !== 6) {
      otpStatusEl.textContent = 'Enter the 6-digit code from your email.';
      otpStatusEl.setAttribute('data-state', 'error');
      otpInput.focus();
      return;
    }

    if (!collectedInputs) {
      otpStatusEl.textContent = 'Your answers got reset (maybe the page reloaded). Please click Reset below and start over.';
      otpStatusEl.setAttribute('data-state', 'error');
      return;
    }

    var submitBtn = otpForm.querySelector('.scorecard-submit');
    submitBtn.disabled = true;
    otpStatusEl.textContent = 'Verifying and building your Champion Program recommendation…';
    otpStatusEl.setAttribute('data-state', 'loading');

    var payload = Object.assign({}, collectedInputs, {
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
        finalEl.innerHTML =
          '<span class="scorecard-tier scorecard-tier-' + (collectedInputs.tier === 'Not Ready' ? 'not-ready' : collectedInputs.tier === 'Nurture' ? 'nurture' : 'ready') + '">' + collectedInputs.tier + '</span>' +
          '<p class="scorecard-score">' + collectedInputs.score + ' / 18 points</p>' +
          '<div class="scorecard-final-body">' + data.recommendation + '</div>';
      })
      .catch(function (err) {
        otpStatusEl.textContent = err.message || 'That code didn\u2019t work. Please try again or resend a new code.';
        otpStatusEl.setAttribute('data-state', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });

  resetBtn.addEventListener('click', function () {
    scorecardForm.reset();
    leadgateForm.reset();
    otpForm.reset();
    leadgateForm.hidden = true;
    otpForm.hidden = true;
    finalEl.hidden = true;
    finalEl.innerHTML = '';
    leadStatusEl.textContent = '';
    leadStatusEl.removeAttribute('data-state');
    otpStatusEl.textContent = '';
    otpStatusEl.removeAttribute('data-state');
    collectedInputs = null;
    placeholderEl.hidden = false;
  });
});
