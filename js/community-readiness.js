document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('crq-form');
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

  document.querySelectorAll('#problem-checks .check-option').forEach(function (label) {
    var input = label.querySelector('input');
    input.addEventListener('change', function () {
      label.classList.toggle('checked', input.checked);
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    collected = {
      health: document.getElementById('q-health').value,
      size: document.getElementById('q-size').value,
      tickets: document.getElementById('q-tickets').value,
      revenue: document.getElementById('q-revenue').value,
      problems: Array.prototype.slice.call(document.querySelectorAll('#problem-checks input:checked')).map(function (el) { return el.value; })
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
      otpStatus.textContent = 'Enter the 6-digit code shown above.';
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
    otpStatus.textContent = 'Verifying…';
    otpStatus.setAttribute('data-state', 'loading');

    var payload = {
      email: document.getElementById('lead-email').value.trim(),
      phone: document.getElementById('lead-phone').value.trim(),
      otp: otpInput.value.trim(),
      health: collected.health,
      size: collected.size,
      tickets: collected.tickets,
      revenue: collected.revenue,
      problems: collected.problems
    };

    fetch('/api/community-readiness', {
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

        var verdictClass = data.verdict === 'Strong Fit' ? 'verdict-high' : (data.verdict === 'Some Potential' ? 'verdict-mid' : 'verdict-low');
        var toolTypeHtml = data.toolType ? '<div class="tool-type-box"><b>Recommended tool type:</b> ' + data.toolType + '</div>' : '';
        var solutionsHtml = (data.solutions && data.solutions.length)
          ? '<div class="solutions-row">' + data.solutions.map(function (s) { return '<span class="solution-tag">' + s + '</span>'; }).join('') + '</div>'
          : '';

        finalEl.innerHTML =
          '<span class="verdict-badge ' + verdictClass + '">' + data.verdict + '</span>' +
          '<div class="score-line">Fit score: ' + data.score.toFixed(1) + ' / 6</div>' +
          toolTypeHtml +
          solutionsHtml +
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
    document.querySelectorAll('#problem-checks .check-option').forEach(function (l) { l.classList.remove('checked'); });
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
