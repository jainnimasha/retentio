document.addEventListener('DOMContentLoaded', function () {
  var PILLARS = {
    r: 'Relationships', e: 'Engagement', t: 'Trust',
    a: 'Advocacy', i: 'Insights', n: 'Nurture'
  };
  var PILLAR_KEYS = ['r', 'e', 't', 'a', 'i', 'n'];

  var form = document.getElementById('retain-form');
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

  var collected = null;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var pillarScores = {};
    var total = 0;
    PILLAR_KEYS.forEach(function (k) {
      var q1 = parseInt(form.querySelector('input[name="' + k + '1"]:checked').value, 10);
      var q2 = parseInt(form.querySelector('input[name="' + k + '2"]:checked').value, 10);
      var sum = q1 + q2;
      pillarScores[PILLARS[k]] = sum;
      total += sum;
    });

    var overallPct = Math.round((total / 60) * 100);
    var sortedKeys = PILLAR_KEYS.slice().sort(function (a, b) { return pillarScores[PILLARS[a]] - pillarScores[PILLARS[b]]; });
    var weakest = PILLARS[sortedKeys[0]];
    var strongest = PILLARS[sortedKeys[sortedKeys.length - 1]];

    collected = { pillarScores: pillarScores, total: total, overallPct: overallPct, weakest: weakest, strongest: strongest };

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
    otpStatus.textContent = 'Verifying and building your Health Check…';
    otpStatus.setAttribute('data-state', 'loading');

    var payload = {
      email: document.getElementById('lead-email').value.trim(),
      phone: document.getElementById('lead-phone').value.trim(),
      otp: otpInput.value.trim(),
      pillar_scores: collected.pillarScores,
      overall_pct: collected.overallPct,
      weakest: collected.weakest,
      strongest: collected.strongest
    };

    fetch('/api/retain-health-check', {
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

        var barsHtml = PILLAR_KEYS.map(function (k) {
          var name = PILLARS[k];
          var score = collected.pillarScores[name];
          var pct = (score / 10) * 100;
          return '<div class="pillar-bar-row"><span class="pillar-bar-name">' + name + '</span><div class="pillar-bar-track"><div class="pillar-bar-fill" style="width:' + pct + '%"></div></div><span class="pillar-bar-val">' + score + '/10</span></div>';
        }).join('');

        finalEl.innerHTML =
          '<div class="overall-label">RETAIN Health Score</div>' +
          '<div class="overall-score">' + collected.overallPct + '%</div>' +
          '<div class="pillar-bars">' + barsHtml + '</div>' +
          '<div class="ws-callout"><span class="ws-tag ws-weak">Weakest: ' + collected.weakest + '</span><span class="ws-tag ws-strong">Strongest: ' + collected.strongest + '</span></div>' +
          '<div class="tool-final-body">' + data.explanation + '</div>';
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
