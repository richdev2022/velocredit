CREATE UNIQUE INDEX IF NOT EXISTS loan_applications_application_id_unique_idx
  ON loan_applications (application_id);
