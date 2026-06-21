import { useState, useEffect } from 'react';

export function useFormattedDate(
  dateValue: string | Date | number | undefined,
  formatType: 'locale' | 'time' | 'date' = 'locale'
): string {
  const [formatted, setFormatted] = useState('');

  useEffect(() => {
    if (!dateValue) return;
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return;

    if (formatType === 'time') {
      setFormatted(date.toLocaleTimeString());
    } else if (formatType === 'date') {
      setFormatted(date.toLocaleDateString());
    } else {
      setFormatted(date.toLocaleString());
    }
  }, [dateValue, formatType]);

  return formatted;
}
