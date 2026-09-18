document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('contact-form');
  if (!form) return;

  var statusEl = document.getElementById('contact-status');
  var submitBtn = form.querySelector('.contact-submit');
  var emailInput = document.getElementById('work_email');

  function setStatus(message, state) {
    statusEl.textContent = message;
    statusEl.setAttribute('data-state', state || '');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Basic required-field check (Work Email is the only mandatory field)
    if (!emailInput.value || !emailInput.validity.valid) {
      setStatus('Please enter a valid work email.', 'error');
      emailInput.focus();
      return;
    }

    var payload = {
      name: form.name.value.trim(),
      work_email: form.work_email.value.trim(),
      phone: form.phone.value.trim(),
      company: form.company.value.trim(),
      message: form.message.value.trim(),
      // Honeypot — should always be empty for real visitors
      company_website: form.company_website.value
    };

    submitBtn.disabled = true;
    setStatus('Sending…', '');

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Request failed');
        return res.json();
      })
      .then(function () {
        setStatus("Thanks — we'll be in touch within one business day.", 'success');
        form.reset();
      })
      .catch(function () {
        setStatus('Something went wrong. Please email contact@retentio.in directly.', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });
});
