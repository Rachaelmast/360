# SkyBridge 360 Review

360-degree feedback for SkyBridge Healthcare staff: Recruiter, Account Manager, Director, and Executive VP of Operations.

- **Overview** (editors/owner): every open review with a completion ring, due-date status, and which reviewer groups are still missing, plus a company-wide pulse on the six core competencies.
- **Give feedback**: reviewers pick a person and how they work with them, then go through one competency at a time (keys 1 to 5 rate, N for N/A). Drafts save as they go, and they check their answers before submitting.
- **Reviews** (editors/owner): open reviews with a due date, copy a ready-to-send invite message, and close, reopen, or delete reviews.
- **Reports** (editors/owner): a radar chart comparing self with others, top strengths and growth areas, blind spots and hidden strengths, a heatmap by relationship, a development plan, comments, an optional Claude summary of the comments, and a CSV export.
- **Question bank**: every statement for each title.
- **Sample data**: placeholder people and feedback show how everything works. It turns off on its own once a real review exists, and it's never saved.

Open `index.html` in a browser to use it locally. Locally, data stays in that browser only.

# SkyBridge VMS

A vendor management system in `vms/`. Facilities post openings, vendor agencies submit clinicians, and SkyBridge runs everything in between.

- **Dashboard**: open positions, fill rate, submittals to review, clinicians working, timesheets to approve, and billing. A "Needs attention" list flags expired or missing credentials, vendor insurance and contracts near expiry, openings starting soon with no candidates, and rates above the bill rate. There's also a candidate pipeline and a vendor scorecard.
- **Requisitions**: post, edit, hold, and release openings to Tier 1 vendors first and then to all tiers.
- **Submittals**: a stage board (Submitted → Shortlisted → Interview → Offer → Accepted). It blocks duplicate candidates (same name or license on the same requisition) and warns when a proposed rate is above the bill rate. Accepting an offer books the assignment and marks the requisition filled once every opening is taken.
- **Assignments**: dates, bill rate, credential expiry (license, BLS, TB, physical, background) with a 30-day warning, extend, and end.
- **Timesheets**: weekly hours, Sunday to Saturday; hours over 40 bill at 1.5×. The facility approves or sends back with a reason.
- **Invoices**: one invoice per facility from approved timesheets. Shows vendor payables after the VMS fee. Can be marked sent or paid and exported to CSV.
- **Vendors & facilities**: tiers, status, compliance documents, VMS fee, and units.
- **Viewing as**: switch between SkyBridge admin, a facility manager and a vendor to see each side. This is a view switch, **not a login**: anyone with the link can switch. Real per-vendor and per-facility access needs a server backend.
- **Sample data**: placeholder facilities, vendors and clinicians. It shows until a real record exists and is never saved.

Open `vms/index.html` in a browser to use it locally. Locally, data stays in that browser only.
