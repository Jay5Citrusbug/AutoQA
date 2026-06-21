import React, { useState, useEffect } from 'react';

interface SafeFormattedDateProps {
  value: string | number | Date | undefined;
  format?: 'locale' | 'time' | 'date';
  fallback?: string;
}

export default function SafeFormattedDate({
  value,
  format = 'locale',
  fallback = ''
}: SafeFormattedDateProps) {
  const [formatted, setFormatted] = useState(fallback);

  useEffect(() => {
    if (!value) {
      setFormatted(fallback);
      return;
    }
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      setFormatted(fallback);
      return;
    }

    if (format === 'time') {
      setFormatted(date.toLocaleTimeString());
    } else if (format === 'date') {
      setFormatted(date.toLocaleDateString());
    } else {
      setFormatted(date.toLocaleString());
    }
  }, [value, format, fallback]);

  return <>{formatted}</>;
}
