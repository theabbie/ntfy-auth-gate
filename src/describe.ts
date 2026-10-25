import type { GateSubject, Prompt } from "./types";

const maxUrlLength = 200;
const maxUserAgentLength = 120;

function clean(value: string, limit: number): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

export function defaultDescribe(subject: GateSubject): Prompt {
  const lines = [`${clean(subject.method, 16)} ${clean(subject.url, maxUrlLength)}`];
  if (subject.ip) lines.push(`from ${clean(subject.ip, 64)}`);
  if (subject.userAgent) lines.push(clean(subject.userAgent, maxUserAgentLength));
  return {
    title: "Approve API request",
    message: lines.join("\n"),
    tags: ["lock"],
  };
}
