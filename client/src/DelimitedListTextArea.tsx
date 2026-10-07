import { useEffect, useState, type TextareaHTMLAttributes } from 'react';

export const parseDelimitedList = (text: string) => text.split(/[，,、;；\n]/).map(item => item.trim()).filter(Boolean);

/** Keep the editable text intact while publishing its parsed values to the form. */
export default function DelimitedListTextArea({ values, onValuesChange, ...props }:
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    values: string[]; onValuesChange: (values: string[]) => void;
  }) {
  const [text, setText] = useState(() => values.join('，'));
  const key = JSON.stringify(values);
  useEffect(() => {
    setText(previous => JSON.stringify(parseDelimitedList(previous)) === key ? previous : values.join('，'));
  }, [key]);
  return <textarea {...props} value={text} onChange={event => {
    const next = event.target.value;
    setText(next);
    onValuesChange(parseDelimitedList(next));
  }} />;
}