import Link from "next/link";
import Sheet from "@/components/Sheet";
import { getGraph } from "@/lib/db";
import { SITE } from "@/lib/site";
import s from "../plain.module.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "About",
  description: "What the Brain map is and how to read it.",
  alternates: { canonical: "/about" },
};

export default function About() {
  const g = getGraph(), n = (v: number) => v.toLocaleString("en-US");
  return (
    <Sheet here="about" className={s.page}>
      <h1>{SITE.tagline}</h1>
      <p>
        {SITE.name} is the Beast&apos;s own knowledge, mapped: {n(g.weaknessCount)} offensive skills and its full tool arsenal grouped into {n(g.classes.length)}{" "}
        domains, the lessons it has learned across targets, and the findings from every engagement. It reads this machine&apos;s live Beast data and updates
        itself as the Beast runs.
      </p>

      <h2>How to read the map</h2>
      <ul>
        <li>Each node on the inner ring is a domain. Each strip beyond it is a skill or a tool family, and each dot in a strip is a technique, a tool, or a finding.</li>
        <li>Lines through the middle join domains that come up together. Thicker lines mean a stronger link.</li>
        <li>The Programs view is an index of targets: open one to fan out what was found on it, class by class, and then the domains it runs.</li>
        <li>The Lessons view is a timeline of what the Beast has learned: a strip for each month, with bands from validated down to still-exploratory, built from its own lessons file.</li>
      </ul>

      <p><Link href="/">Open the map</Link></p>
    </Sheet>
  );
}
