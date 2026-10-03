/*
	Hyperspace by HTML5 UP
	html5up.net | @ajlkn
	Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)
*/

(function($) {

	var	$window = $(window),
		$body = $('body'),
		$sidebar = $('#sidebar');

	// Breakpoints.
		breakpoints({
			xlarge:   [ '1281px',  '1680px' ],
			large:    [ '981px',   '1280px' ],
			medium:   [ '737px',   '980px'  ],
			small:    [ '481px',   '736px'  ],
			xsmall:   [ null,      '480px'  ]
		});

	// Hack: Enable IE flexbox workarounds.
		if (browser.name == 'ie')
			$body.addClass('is-ie');

	// Play initial animations on page load.
		$window.on('load', function() {
			window.setTimeout(function() {
				$body.removeClass('is-preload');
			}, 100);
		});

	// Forms.

		// Hack: Activate non-input submits.
			$('form').on('click', '.submit', function(event) {

				// Stop propagation, default.
					event.stopPropagation();
					event.preventDefault();

				// Submit form.
					$(this).parents('form').submit();

			});

	// Sidebar.
		if ($sidebar.length > 0) {

			var $sidebar_a = $sidebar.find('nav a');

			// Smoothly scroll sidebar links to their sections.
			$sidebar_a.on('click', function(event) {

				var id = $(this).attr('href');

				if (!id || id.charAt(0) !== '#')
					return;

				var section = document.querySelector(id);

				if (!section)
					return;

				event.preventDefault();

				var offset = 0;

				// On layouts where the sidebar becomes a top navigation bar,
				// leave room for it.
				if (window.innerWidth <= 1280 && window.innerWidth > 736)
					offset = $sidebar.outerHeight();

				window.scrollTo({
					top: section.offsetTop - offset,
					behavior: 'smooth'
				});

			});

			// Highlight whichever section is currently being viewed.
			var sections = [];

			$sidebar_a.each(function() {
				var id = $(this).attr('href');

				if (id && id.charAt(0) === '#') {
					var section = document.querySelector(id);

					if (section)
						sections.push(section);
				}
			});

			function updateSidebar() {

				var marker = window.innerHeight * 0.35;
				var current = sections[0];

				sections.forEach(function(section) {
					if (section.getBoundingClientRect().top <= marker)
						current = section;
				});

				$sidebar_a.removeClass('active');

				if (current) {
					$sidebar_a
						.filter('[href="#' + current.id + '"]')
						.addClass('active');
				}
			}

			$window.on('scroll resize', updateSidebar);
			updateSidebar();

		}

	// Scrolly.
		$('.scrolly').scrolly({
			speed: 500,
			offset: function() {

				// If <=large, >small, and sidebar is present, use its height as the offset.
					if (breakpoints.active('<=large')
					&&	!breakpoints.active('<=small')
					&&	$sidebar.length > 0)
						return $sidebar.height();

				return 0;

			}
		});

	// Spotlights.
		$('.spotlights > section')
			.scrollex({
				mode: 'middle',
				top: '-10vh',
				bottom: '-10vh',
				initialize: function() {

					// Deactivate section.
						$(this).addClass('inactive');

				},
				enter: function() {

					// Activate section.
						$(this).removeClass('inactive');

				}
			})
			.each(function() {

				var	$this = $(this),
					$image = $this.find('.image'),
					$img = $image.find('img'),
					x;

				// Assign image.
					$image.css('background-image', 'url(' + $img.attr('src') + ')');

				// Set background position.
					if (x = $img.data('position'))
						$image.css('background-position', x);

				// Hide <img>.
					$img.hide();

			});

	// Features.
		$('.features')
			.scrollex({
				mode: 'middle',
				top: '-20vh',
				bottom: '-20vh',
				initialize: function() {

					// Deactivate section.
						$(this).addClass('inactive');

				},
				enter: function() {

					// Activate section.
						$(this).removeClass('inactive');

				}
			});

})(jQuery);