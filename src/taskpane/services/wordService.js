function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function getRangeByScope(context, scope) {
  const selection = context.document.getSelection();

  if (scope === "paragraph") {
    const paragraph = selection.paragraphs.getFirst();
    return paragraph.getRange();
  }

  if (scope === "document") {
    return context.document.body;
  }

  return selection;
}

export async function getScopeText(scope) {
  return Word.run(async (context) => {
    const range = getRangeByScope(context, scope);
    range.load("text");
    await context.sync();

    return {
      text: range.text,
      wordCount: countWords(range.text),
    };
  });
}

function formatCommentText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("AI:") ? trimmed : `AI: ${trimmed}`;
}

async function insertComments(context, range, comments) {
  const lookups = comments
    .filter((comment) => comment && comment.comment)
    .map((comment) => ({
      anchorText: comment.anchorText,
      comment: formatCommentText(comment.comment),
      matches: null,
    }));

  for (const entry of lookups) {
    if (entry.anchorText) {
      entry.matches = range.search(entry.anchorText, {
        matchCase: false,
        matchWholeWord: false,
      });
      entry.matches.load("items");
    }
  }

  await context.sync();

  for (const entry of lookups) {
    const target = entry.matches && entry.matches.items.length
      ? entry.matches.items[0]
      : range;
    target.insertComment(entry.comment);
  }
}

export async function applyRedlines({ scope, revisedText, comments, trackChanges }) {
  return Word.run(async (context) => {
    const range = getRangeByScope(context, scope);
    context.document.load("changeTrackingMode");
    await context.sync();

    const previousMode = context.document.changeTrackingMode;
    if (trackChanges) {
      context.document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }

    range.insertText(revisedText, Word.InsertLocation.replace);

    if (comments && comments.length) {
      await insertComments(context, range, comments);
    }

    await context.sync();

    if (trackChanges) {
      context.document.changeTrackingMode = previousMode;
      await context.sync();
    }
  });
}
