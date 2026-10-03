ALTER TABLE requirements
  DROP CONSTRAINT requirements_status_fixed;

ALTER TABLE requirements
  ADD CONSTRAINT requirements_status_fixed CHECK (
    status IN (
      'draft',
      'in_refinement',
      'ready_for_development',
      'in_development',
      'in_testing',
      'completed',
      'on_hold'
    )
  );
