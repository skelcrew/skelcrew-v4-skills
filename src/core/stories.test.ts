import { expect, test } from "bun:test";
import { stories, tell } from "./stories";

for (const story of stories) {
  test(story.name, () => {
    expect(tell(story.lines)).toMatchSnapshot();
  });
}
