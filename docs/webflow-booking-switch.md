# Webflow: switch "Book a call" from Calendly to the Alderlux booking page

Draft prepared 06/11/2026. Nothing has been changed or published on alderlux.com.
Robert makes both edits in Webflow, checks the staging site, then publishes.

## What uses Calendly today (checked on the live site, 63 pages)

1. **Every page**: Site settings → Custom code → Footer has a script that opens a Calendly
   pop-up (the-edge-introductory-call-clone) when any element with the class `book-call` is clicked.
2. **Contact page** (/alderluxcontact): an Embed element in "Option One — Book A Free Consultation"
   holds an inline Calendly calendar.

## Edit 1 — Site settings → Custom code → Footer code

Find the block that starts `<!-- CALENDLY — loads only when a Book a call button is clicked.`
and ends with its closing `</script>`. Replace that whole block (only that block — leave the
cookie consent code below it untouched) with:

```html
<!-- BOOKING — "Book a call" buttons open the Alderlux booking page (replaced Calendly 06/11/2026). -->
<script>
  document.addEventListener('DOMContentLoaded', function () {
    var BOOK = 'https://alderlux-booking.rob-h-masons.workers.dev/';
    var p = location.pathname.replace(/\/$/, '');
    var type = 'the-edge';
    if (p === '/succession' || p === '/packages/succession') type = 'succession';
    if (p === '/bitcoin-for-business-uk' || p === '/bitcoin-limited-company-uk') type = 'corporate';
    document.querySelectorAll('.book-call').forEach(function (el) {
      if (el.tagName === 'A') el.setAttribute('href', BOOK + '?type=' + type);
      el.addEventListener('click', function (e) {
        e.preventDefault();
        window.location.href = BOOK + '?type=' + type;
      });
    });
  });
</script>
```

## Edit 2 — Contact page, Option One embed

In the Designer, open the Contact page, select the Embed inside "Book A Free Consultation"
and replace only these two lines:

```html
<div class='calendly-inline-widget' data-url='https://calendly.com/alderlux/the-edge-introductory-call-clone?hide_gdpr_banner=1&primary_color=c7a45d' style='min-width:320px;height:700px;'></div><script type='text/javascript' src='https://assets.calendly.com/assets/external/widget.js' async></script>
```

with:

```html
<iframe src='https://alderlux-booking.rob-h-masons.workers.dev/?type=the-edge' title='Book a free consultation' loading='lazy' style='width:100%;min-width:320px;height:760px;border:0;'></iframe><p style='margin-top:12px'><a href='https://alderlux-booking.rob-h-masons.workers.dev/?type=the-edge'>Open the booking page in a new window</a></p>
```

The booking page allows being shown inside alderlux.com (its frame-ancestors rule names
https://alderlux.com). It cannot be tested from inside alderlux.com until it is on staging,
so check it there; the link underneath is the fallback if the frame shows blank.

## Check before publishing (on the webflow.io staging site)

1. Click "Book a call" on the home page, The Edge, Succession and one Insider article:
   each opens the booking page with the right call type selected.
2. Contact page: the booking calendar shows inside Option One.
3. Make a test booking for a time you will cancel; the confirmation arrives from admin@alderlux.com.
4. Then publish, and turn Calendly off only after a real booking has come through.

## Later

- If book.alderlux.com is set up, change `BOOK` and the two contact-page links to it.
- Warning: other automations publish the whole site (e.g. Library monthly review, Insider
  publication). Unpublished Designer edits go live with the next publish by anyone or anything,
  so make both edits in one sitting and publish straight after checking.
