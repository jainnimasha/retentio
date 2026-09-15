(function () {
  function handleSubmit(e) {
    e.preventDefault();
    var form = e.target;
    form.innerHTML = '<p style="color:#A8D878;font-size:16px;font-weight:700">\u2713 Check your inbox \u2014 the prompt library is on its way!</p>';
  }
  window.handleSubmit = handleSubmit;

  var page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links > a, .nav-links .nav-dropdown-toggle').forEach(function (a) {
    var href = a.getAttribute('href');
    if (href === page) a.classList.add('active');
  });

  var retainMap = {
    R: ['Customer Advocacy','Community','Events & User Groups'],
    E: ['Webinars','Community','Content Marketing','Customer Marketing'],
    T: ['Customer Stories','Content Marketing','Webinars'],
    A: ['Customer Advocacy','Customer Stories','Events & User Groups','Webinars'],
    I: ['Impact Measurement','Customer Marketing','Customer Advocacy','Community'],
    N: ['Customer Marketing','Community','Content Marketing','Webinars']
  };

  var retainCopy = {
    R: 'Build the customer relationships that create the foundation for growth.',
    E: 'Keep customers participating, learning and moving forward.',
    T: 'Turn customer success into proof your market can believe.',
    A: 'Give your strongest customers a reason and a way to advocate.',
    I: 'Turn customer signals into better decisions.',
    N: 'Keep valuable customer relationships active over time.'
  };

  var retainGradients = {
    R:'linear-gradient(135deg,#2D2E6E,#4A4DB8)',
    E:'linear-gradient(135deg,#4A4DB8,#6B4FBB)',
    T:'linear-gradient(135deg,#6B4FBB,#A040A0)',
    A:'linear-gradient(135deg,#A040A0,#C8407A)',
    I:'linear-gradient(135deg,#C8407A,#E8605A)',
    N:'linear-gradient(135deg,#E8605A,#E8735A)'
  };

  var currentLetter = null;

  function activateRetain(letter) {
    if (currentLetter === letter) { resetRetain(); return; }
    currentLetter = letter;

    document.querySelectorAll('.retain-tile').forEach(function (t) {
      var isActive = t.dataset.letter === letter;
      t.classList.toggle('rt-active', isActive);
      t.classList.toggle('rt-dim', !isActive);
      if (isActive) {
        t.querySelector('.retain-tile-glow').style.background = retainGradients[letter];
      }
    });

    var helper = document.getElementById('retain-microcopy');
    if (helper) {
      helper.textContent = retainCopy[letter];
      helper.classList.add('is-active');
    }

    var active = retainMap[letter];
    document.querySelectorAll('.rs-tile').forEach(function (t) {
      var name = t.querySelector('.rs-tile-name');
      var isHit = name && active.some(function (prog) {
        return name.textContent.trim() === prog;
      });
      t.classList.toggle('rs-active', isHit);
      t.classList.toggle('rs-dim', !isHit);
    });

    var resetBtn = document.getElementById('retain-reset');
    if (resetBtn) resetBtn.style.display = 'inline-block';
  }

  function resetRetain() {
    currentLetter = null;

    document.querySelectorAll('.retain-tile').forEach(function (t) {
      t.classList.remove('rt-active','rt-dim');
    });

    var helper = document.getElementById('retain-microcopy');
    if (helper) {
      helper.textContent = 'Click a pillar to see how it connects to our solutions.';
      helper.classList.remove('is-active');
    }

    document.querySelectorAll('.rs-tile').forEach(function (t) {
      t.classList.remove('rs-active','rs-dim');
    });

    var resetBtn = document.getElementById('retain-reset');
    if (resetBtn) resetBtn.style.display = 'none';
  }

  window.activateRetain = activateRetain;
  window.resetRetain = resetRetain;

  document.querySelectorAll('.retain-tile').forEach(function (tile) {
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateRetain(tile.dataset.letter);
      }
    });
  });
})();
