document.addEventListener('DOMContentLoaded', function () {
  var forms = document.querySelectorAll('[data-resource-form]');

  forms.forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // Client-side only for now, matching the homepage's existing prompt
      // library signup — no backend wired up yet. Swap in a real submit
      // (e.g. to /api/subscribe) when that's ready.
      form.innerHTML = '<p style="margin:0;color:#1c8a4e;font-size:14px;font-weight:700">✓ Thanks — check your inbox shortly.</p>';
    });
  });
});
