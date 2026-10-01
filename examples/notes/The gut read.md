# The gut read

The thin bar above each answer in kan's web page is its gut read: how sure the small model was that your notes are worth using for this question.

It comes from one forward pass. The model is shown the question and the closest notes, asked to pick "use" or "ignore", and the probabilities of those two answers are read directly. Nothing is generated, so it can't ramble or pick something else.

A full bar means it's confident. A bar near half means it doesn't know, and kan leans towards using the notes, because an unneeded note costs a little context while a missing one costs a wrong answer.
