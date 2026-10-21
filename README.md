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

A vendor management system in `vms/`, modeled on what SAP Fieldglass does for contingent staffing and built for home health, hospice and acute care. Facilities post openings, vendor agencies submit clinicians, and SkyBridge runs everything in between.

**Fieldglass-style workflow**
- **Approvals:** facilities submit requisitions for SkyBridge to approve or send back with a note.
- **Rate cards:** each facility has a target and max rate per discipline, billed hourly or per visit. Target fills in new requisitions; above max needs a written reason and is flagged at approval.
- **Distribution:** release to Tier 1 vendors, then all tiers automatically after 1–5 days, or all at once.
- **Submittals:** a stage board (Submitted → Shortlisted → Interview → Offer → Accepted) with interview scheduling and 1–5 feedback scores. Duplicate candidates (same name or license on a requisition) are blocked, and rates above the bill rate are flagged.
- **Onboarding:** credentials (license, BLS, TB, physical, background) plus a pre-start checklist. A clinician is "cleared to start" only when everything is valid on day one.
- **Time & expenses:** weekly hours or visits with overtime after 40 hours, mileage at each facility's rate, and other expenses. Facilities approve one by one or all at once.
- **Consolidated invoicing:** one invoice per facility from approved time. The VMS fee comes out of labor only; expenses pass through to the vendor.
- **Budgets and reports:** each facility's annual budget against invoiced and committed spend, spend by facility, vendor and discipline, CSV export, a vendor scorecard, and a full activity log.

**Where it goes further**
- **Search everything:** press Ctrl K (or /) to search requisitions, candidates, clinicians, invoices, vendors and facilities.
- **Home-health ready:** per-visit billing, mileage, and a link to Nursys for nurse license checks.
- **Claude built in (published page only):** paste a job posting to fill in a requisition, compare a requisition's candidates, and ask questions about your data in Reports. Every answer is labeled as Claude's and is meant to be checked.
- **Fewer clicks:** one-click stage moves, "Approve all" for time, a dashboard "Needs attention" list that opens the exact record, and a layout that works on a phone.

**Viewing as** switches between SkyBridge admin, a facility manager and a vendor to show each side. This is a view switch, **not a login**: anyone with the link can switch. Real per-vendor and per-facility access needs a server backend.

**Sample data** fills the page until a real record exists, and it's never saved. Open `vms/index.html` in a browser to use it locally, where data stays in that browser only and the Claude features are hidden.
