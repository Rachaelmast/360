-- Vendor management system (VMS) seen on the job posting.
ALTER TABLE job_postings ADD COLUMN vms_name text, ADD COLUMN vms jsonb;
