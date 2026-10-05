export type FieldError = { field: string; messages: string[] };

export type StepErrors = {
  apiError: string;
  fieldErrors: FieldError[];
};

export const emptyErrors: StepErrors = { apiError: '', fieldErrors: [] };

/**
 * Show what actually failed. The flows report field-level validation errors
 * separately from the API error, and swallowing either one is how you end up
 * staring at a step that silently refuses to advance.
 */
export function AlertError({ errors }: { errors: StepErrors }) {
  if (!errors.apiError && errors.fieldErrors.length === 0) return null;

  return (
    <div className="alert error">
      {errors.apiError ? (
        <p style={{ margin: 0 }}>
          <strong>Request failed:</strong> {errors.apiError}
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          <strong>The form was rejected.</strong>
        </p>
      )}
      {errors.fieldErrors.length > 0 && (
        <ul>
          {errors.fieldErrors.map((fe) => (
            <li key={fe.field}>
              <code>{fe.field}</code> — {fe.messages.join('; ')}
            </li>
          ))}
        </ul>
      )}
      <p style={{ margin: '8px 0 0', fontSize: 12 }}>
        The server console prints the upstream status for every call; the same
        lines are appended to <code>results/proxy-log.jsonl</code>.
      </p>
    </div>
  );
}
