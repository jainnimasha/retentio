(function () {
  function toggleNav() {
    var nav = document.getElementById('mobileNav');
    if (nav) nav.classList.toggle('open');
  }
  window.toggleNav = toggleNav;

  document.addEventListener('click', function (e) {
    var nav = document.getElementById('mobileNav');
    var toggle = document.querySelector('.nav-mobile-toggle');
    if (nav && toggle && !nav.contains(e.target) && !toggle.contains(e.target)) {
      nav.classList.remove('open');
    }
    document.querySelectorAll('.nav-dropdown').forEach(function (drop) {
      if (!drop.contains(e.target)) drop.classList.remove('open');
    });
  });

  document.querySelectorAll('.nav-dropdown-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function (e) {
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      var links = document.querySelector('.nav-links');
      if (!links || window.getComputedStyle(links).display === 'none') return;
      e.preventDefault();
      toggle.closest('.nav-dropdown').classList.toggle('open');
    });
  });

  document.querySelectorAll('.nav-mobile-sub-toggle').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var item = btn.closest('.nav-mobile-item');
      if (!item) return;
      btn.setAttribute('aria-expanded', String(item.classList.toggle('open')));
    });
  });

  document.querySelectorAll('#mobileNav a').forEach(function (a) {
    a.addEventListener('click', function () {
      var nav = document.getElementById('mobileNav');
      if (nav) nav.classList.remove('open');
    });
  });
})();
