const functions = require("firebase-functions");
const admin = require("firebase-admin");
let key = "./serviceAccountKey.json";

if (process.env.GCLOUD_PROJECT === "monkey-type") {
  key = "./serviceAccountKey_live.json";
}

var serviceAccount = require(key);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

exports.moveResults = functions
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onCall((request, response) => {
    return db
      .collection("results")
      .orderBy("timestamp", "desc")
      .limit(2000)
      .get()
      .then((data) => {
        data.docs.forEach((doc) => {
          let result = doc.data();
          if (result.moved === undefined || result.moved === false) {
            db.collection(`results`).doc(doc.id).update({ moved: true });
            db.collection(`users/${result.uid}/results`).add(result);
            console.log(`moving doc ${doc.id}`);
          }
        });
        return;
      });
  });

function getAllNames() {
  return admin
    .auth()
    .listUsers()
    .then((data) => {
      let names = [];
      data.users.forEach((user) => {
        names.push(user.displayName);
      });
      return names;
    });
}

function getAllUsers() {
  return admin
    .auth()
    .listUsers()
    .then((data) => {
      return data.users;
    });
}

function isUsernameValid(name) {
  if (name === null || name === undefined || name === "") return false;
  if (/miodec/.test(name.toLowerCase())) return false;
  if (/bitly/.test(name.toLowerCase())) return false;
  if (name.length > 14) return false;
  return /^[0-9a-zA-Z_.-]+$/.test(name);
}

exports.checkNameAvailability = functions.https.onCall((request, response) => {
  // 1 - available
  // -1 - unavailable (taken)
  // -2 - not valid name
  // -999 - unknown error
  try {
    if (!isUsernameValid(request.name)) return -2;
    return getAllNames().then((data) => {
      let available = 1;
      data.forEach((name) => {
        try {
          if (name.toLowerCase() === request.name.toLowerCase()) available = -1;
        } catch (e) {
          //
        }
      });
      return available;
    });
  } catch (e) {
    return -999;
  }
});

exports.changeName = functions.https.onCall((request, response) => {
  try {
    if (!isUsernameValid(request.name)) {
      console.warn(
        `${request.uid} tried to change their name to ${request.name} - not valid`
      );
      return 0;
    }
    return getAllNames().then((data) => {
      let available = 1;
      data.forEach((name) => {
        try {
          if (name.toLowerCase() === request.name.toLowerCase()) available = 0;
        } catch (e) {
          //
        }
      });
      if (available === 1) {
        return admin
          .auth()
          .updateUser(request.uid, {
            displayName: request.name,
          })
          .then((d) => {
            console.log(
              `${request.uid} changed their name to ${request.name} - done`
            );
            return 1;
          })
          .catch((e) => {
            console.error(
              `${request.uid} tried to change their name to ${request.name} - ${e.message}`
            );
            return -1;
          });
      } else {
        console.warn(
          `${request.uid} tried to change their name to ${request.name} - already taken`
        );
        return 0;
      }
    });
  } catch (e) {
    console.error(
      `${request.uid} tried to change their name to ${request.name} - ${e}`
    );
    return -1;
  }
});

exports.checkIfNeedsToChangeName = functions.https.onCall(
  (request, response) => {
    try {
      return db
        .collection("users")
        .doc(request.uid)
        .get()
        .then((doc) => {
          if (
            doc.data().name === undefined ||
            doc.data().name === null ||
            doc.data().name === ""
          ) {
            return admin
              .auth()
              .getUser(request.uid)
              .then((requestUser) => {
                if (!isUsernameValid(requestUser.displayName)) {
                  //invalid name, needs to change
                  console.log(
                    `user ${requestUser.uid} ${requestUser.displayName} needs to change name`
                  );
                  return 1;
                } else {
                  //valid name, but need to change if not duplicate

                  return getAllUsers()
                    .then((users) => {
                      let sameName = [];

                      //look for name names
                      users.forEach((user) => {
                        if (user.uid !== requestUser.uid) {
                          try {
                            if (
                              user.displayName.toLowerCase() ===
                              requestUser.displayName.toLowerCase()
                            ) {
                              sameName.push(user);
                            }
                          } catch (e) {
                            //
                          }
                        }
                      });

                      if (sameName.length === 0) {
                        db.collection("users")
                          .doc(request.uid)
                          .update({ name: requestUser.displayName })
                          .then(() => {
                            return 0;
                          });
                      } else {
                        //check when the request user made the account compared to others
                        let earliestTimestamp = 999999999999999;
                        sameName.forEach((sn) => {
                          let ts =
                            new Date(sn.metadata.creationTime).getTime() / 1000;
                          if (ts <= earliestTimestamp) {
                            earliestTimestamp = ts;
                          }
                        });

                        if (
                          new Date(
                            requestUser.metadata.creationTime
                          ).getTime() /
                            1000 >
                          earliestTimestamp
                        ) {
                          console.log(
                            `user ${requestUser.uid} ${requestUser.displayName} needs to change name`
                          );
                          return 2;
                        } else {
                          db.collection("users")
                            .doc(request.uid)
                            .update({ name: requestUser.displayName })
                            .then(() => {
                              return 0;
                            });
                        }
                      }
                    })
                    .catch((e) => {
                      console.error(`error getting all users - ${e}`);
                    });
                }
              });
          } else {
            console.log("name is good");
            return 0;
          }
        });
    } catch (e) {
      return -1;
    }
  }
);

function checkIfPB(uid, obj) {
  return db
    .collection(`users`)
    .doc(uid)
    .get()
    .then((data) => {
      let pbs = null;
      try {
        pbs = data.data().personalBests;
        if (pbs === undefined) {
          throw new Error("pb is undefined");
        }
      } catch (e) {
        return db
          .collection("users")
          .doc(uid)
          .update({
            personalBests: {
              [obj.mode]: {
                [obj.mode2]: [
                  {
                    language: obj.language,
                    difficulty: obj.difficulty,
                    punctuation: obj.punctuation,
                    wpm: obj.wpm,
                    acc: obj.acc,
                    raw: obj.rawWpm,
                  },
                ],
              },
            },
          })
          .then((e) => {
            return true;
          })
          .catch((e) => {
            return db
              .collection("users")
              .doc(uid)
              .set({
                personalBests: {
                  [obj.mode]: {
                    [obj.mode2]: [
                      {
                        language: obj.language,
                        difficulty: obj.difficulty,
                        punctuation: obj.punctuation,
                        wpm: obj.wpm,
                        acc: obj.acc,
                        raw: obj.rawWpm,
                      },
                    ],
                  },
                },
              })
              .then((e) => {
                return true;
              });
          });
      }
      // //check mode, mode2, punctuation, language and difficulty

      let toUpdate = false;
      let found = false;
      try {
        if (pbs[obj.mode][obj.mode2] === undefined) {
          pbs[obj.mode][obj.mode2] = [];
        }
        pbs[obj.mode][obj.mode2].forEach((pb) => {
          if (
            pb.punctuation === obj.punctuation &&
            pb.difficulty === obj.difficulty &&
            pb.language === obj.language
          ) {
            //entry like this already exists, compare wpm
            found = true;
            if (pb.wpm < obj.wpm) {
              //new pb
              pb.wpm = obj.wpm;
              pb.acc = obj.acc;
              pb.raw = obj.rawWpm;
              toUpdate = true;
            } else {
              //no pb
              return false;
            }
          }
        });
        //checked all pbs, nothing found - meaning this is a new pb
        if (!found) {
          pbs[obj.mode][obj.mode2].push({
            language: obj.language,
            difficulty: obj.difficulty,
            punctuation: obj.punctuation,
            wpm: obj.wpm,
            acc: obj.acc,
            raw: obj.rawWpm,
          });
          toUpdate = true;
        }
      } catch (e) {
        // console.log(e);
        pbs[obj.mode] = {};
        pbs[obj.mode][obj.mode2] = [
          {
            language: obj.language,
            difficulty: obj.difficulty,
            punctuation: obj.punctuation,
            wpm: obj.wpm,
            acc: obj.acc,
            raw: obj.rawWpm,
          },
        ];
        toUpdate = true;
      }

      if (toUpdate) {
        return db
          .collection("users")
          .doc(uid)
          .update({ personalBests: pbs })
          .then((e) => {
            return true;
          });
      } else {
        return false;
      }
    });
}

function stdDev(array) {
  const n = array.length;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n
  );
}

function roundTo2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function validateResult(result) {
  if (result.wpm > result.rawWpm) {
    console.error(
      `Could not validate result for ${result.uid}. ${result.wpm} > ${result.rawWpm}`
    );
    return false;
  }
  let wpm = roundTo2((result.correctChars * (60 / result.testDuration)) / 5);
  if (
    wpm < result.wpm - result.wpm * 0.01 ||
    wpm > result.wpm + result.wpm * 0.01
  ) {
    console.error(
      `Could not validate result for ${result.uid}. wpm ${wpm} != ${result.wpm}`
    );
    return false;
  }
  if (result.allChars != undefined) {
    let raw = roundTo2((result.allChars * (60 / result.testDuration)) / 5);
    if (
      raw < result.rawWpm - result.rawWpm * 0.01 ||
      raw > result.rawWpm + result.rawWpm * 0.01
    ) {
      console.error(
        `Could not validate result for ${result.uid}. raw ${raw} != ${result.rawWpm}`
      );
      return false;
    }
  }
  if (result.mode === "time" && (result.mode2 === 15 || result.mode2 === 60)) {
    let keyPressTimeSum =
      result.keySpacing.reduce((total, val) => {
        return total + val;
      }) / 1000;
    if (
      keyPressTimeSum < result.testDuration - 8 ||
      keyPressTimeSum > result.testDuration + 1
    ) {
      console.error(
        `Could not validate key spacing sum for ${result.uid}. ${keyPressTimeSum} !~ ${result.testDuration}`
      );
      return false;
    }

    if (
      result.testDuration < result.mode2 - 1 ||
      result.testDuration > result.mode2 + 1
    ) {
      console.error(
        `Could not validate test duration for ${result.uid}. ${result.testDuration} !~ ${result.mode2}`
      );
      return false;
    }
  }

  return true;
}

exports.requestTest = functions.https.onRequest((request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "*");
  response.set("Access-Control-Allow-Credentials", "true");
  response.status(200).send({ data: "test" });
});

exports.getPatreons = functions.https.onRequest(async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "*");
  response.set("Access-Control-Allow-Credentials", "true");

  let patreon = await db.collection("patreon").orderBy("value", "desc").get();
  let ret = [];
  patreon.docs.forEach((pdoc) => {
    ret.push(pdoc.data().name);
  });

  // console.log(ret);

  response.status(200).send({ data: ret });
});

async function incrementTestCounter(uid) {
  let userDoc = await db.collection("users").doc(uid).get();
  let userData = userDoc.data();
  if (userData.completedTests === undefined) {
    let results = await db.collection(`users/${uid}/results`).get();
    let count = results.docs.length;
    db.collection("users")
      .doc(uid)
      .update({
        completedTests: admin.firestore.FieldValue.increment(count),
      });
    db.collection("public")
      .doc("stats")
      .update({
        completedTests: admin.firestore.FieldValue.increment(count),
      });
  } else {
    db.collection("users")
      .doc(uid)
      .update({ completedTests: admin.firestore.FieldValue.increment(1) });
    db.collection("public")
      .doc("stats")
      .update({ completedTests: admin.firestore.FieldValue.increment(1) });
  }
}

exports.testCompleted = functions.https.onRequest(async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    // Send response to OPTIONS requests
    response.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
    response.set("Access-Control-Max-Age", "3600");
    response.status(204).send("");
    return;
  }
  request = request.body.data;
  try {
    if (request.uid === undefined || request.obj === undefined) {
      console.error(`error saving result for ${request.uid} - missing input`);
      response.status(200).send({ data: { resultCode: -999 } });
      return;
    }

    let obj = request.obj;

    let err = false;
    Object.keys(obj).forEach((key) => {
      let val = obj[key];
      if (Array.isArray(val)) {
        val.forEach((valarr) => {
          if (!/^[0-9a-zA-Z._]+$/.test(valarr)) err = true;
        });
      } else {
        if (val === undefined || !/^[0-9a-zA-Z._]+$/.test(val)) err = true;
      }
    });
    if (err) {
      console.error(
        `error saving result for ${request.uid} - bad input - ${JSON.stringify(
          request.obj
        )}`
      );
      response.status(200).send({ data: { resultCode: -1 } });
      return;
    }

    if (obj.wpm <= 0 || obj.wpm > 350 || obj.acc < 50 || obj.acc > 100) {
      response.status(200).send({ data: { resultCode: -1 } });
      return;
    }

    if (!validateResult(obj)) {
      if (
        obj.bailedOut &&
        ((obj.mode === "time" && obj.mode2 >= 3600) ||
          (obj.mode === "words" && obj.mode2 >= 5000) ||
          obj.mode === "custom")
      ) {
        //dont give an error
      } else {
        response.status(200).send({ data: { resultCode: -4 } });
        return;
      }
    }

    let keySpacing = null;
    let keyDuration = null;

    try {
      keySpacing = {
        average:
          obj.keySpacing.reduce((previous, current) => (current += previous)) /
          obj.keySpacing.length,
        sd: stdDev(obj.keySpacing),
      };

      keyDuration = {
        average:
          obj.keyDuration.reduce((previous, current) => (current += previous)) /
          obj.keyDuration.length,
        sd: stdDev(obj.keyDuration),
      };
    } catch (e) {
      console.error(
        `cant verify key spacing or duration for user ${request.uid}! - ${e} - ${obj.keySpacing} ${obj.keyDuration}`
      );
    }

    obj.keySpacingStats = keySpacing;
    obj.keyDurationStats = keyDuration;

    if (obj.mode == "time" && (obj.mode2 == 15 || obj.mode2 == 60)) {
    } else {
      obj.keySpacing = "removed";
      obj.keyDuration = "removed";
    }

    emailVerified = await admin
      .auth()
      .getUser(request.uid)
      .then((user) => {
        return user.emailVerified;
      });

    return db
      .collection("users")
      .doc(request.uid)
      .get()
      .then((ret) => {
        let userdata = ret.data();
        let name = userdata.name === undefined ? false : userdata.name;
        let banned = userdata.banned === undefined ? false : userdata.banned;
        let verified = userdata.verified;
        request.obj.name = name;

        //check keyspacing and duration here
        if (obj.mode === "time" && obj.wpm > 130) {
          if (verified === false || verified === undefined) {
            if (keySpacing !== null && keyDuration !== null) {
              if (
                keySpacing.sd <= 15 ||
                keyDuration.sd <= 10 ||
                keyDuration.average < 15 ||
                (obj.wpm > 200 && obj.consistency < 60)
              ) {
                console.error(
                  `possible bot detected by user (${obj.wpm} ${obj.rawWpm} ${
                    obj.acc
                  }) ${request.uid} ${name} - spacing ${JSON.stringify(
                    keySpacing
                  )} duration ${JSON.stringify(keyDuration)}`
                );
                response.status(200).send({ data: { resultCode: -2 } });
                return;
              }
              if (
                (keySpacing.sd > 15 && keySpacing.sd <= 25) ||
                (keyDuration.sd > 10 && keyDuration.sd <= 15) ||
                (keyDuration.average > 15 && keyDuration.average <= 20)
              ) {
                console.error(
                  `very close to bot threshold by user (${obj.wpm} ${
                    obj.rawWpm
                  } ${obj.acc}) ${
                    request.uid
                  } ${name} - spacing ${JSON.stringify(
                    keySpacing
                  )} duration ${JSON.stringify(keyDuration)}`
                );
              }
            } else {
              response.status(200).send({ data: { resultCode: -3 } });
              return;
            }
          }
        }

        return db
          .collection(`users/${request.uid}/results`)
          .add(obj)
          .then((e) => {
            let createdDocId = e.id;
            return Promise.all([
              checkLeaderboards(
                request.obj,
                "global",
                banned,
                name,
                verified,
                emailVerified
              ),
              checkLeaderboards(
                request.obj,
                "daily",
                banned,
                name,
                verified,
                emailVerified
              ),
              checkIfPB(request.uid, request.obj),
            ])
              .then((values) => {
                let globallb = values[0].insertedAt;
                let dailylb = values[1].insertedAt;
                let ispb = values[2];
                // console.log(values);

                incrementTestCounter(request.uid);

                let usr =
                  userdata.discordId !== undefined
                    ? userdata.discordId
                    : userdata.name;

                if (
                  globallb !== null &&
                  globallb.insertedAt >= 0 &&
                  globallb.insertedAt <= 9 &&
                  globallb.newBest
                ) {
                  let lbstring = `${obj.mode} ${obj.mode2} global`;
                  console.log(
                    `sending command to the bot to announce lb update ${
                      userdata.discordId
                    } ${globallb + 1} ${lbstring} ${obj.wpm}`
                  );

                  announceLbUpdate(
                    usr,
                    globallb.insertedAt + 1,
                    lbstring,
                    obj.wpm
                  );
                }

                let returnobj = {
                  resultCode: null,
                  globalLeaderboard: globallb,
                  dailyLeaderboard: dailylb,
                  lbBanned: banned,
                  name: name,
                  createdId: createdDocId,
                  needsToVerify: values[0].needsToVerify,
                  needsToVerifyEmail: values[0].needsToVerifyEmail,
                };

                if (ispb) {
                  let logobj = request.obj;
                  logobj.keySpacing = "removed";
                  logobj.keyDuration = "removed";
                  console.log(
                    `saved result for ${
                      request.uid
                    } (new PB) - ${JSON.stringify(logobj)}`
                  );
                  if (
                    obj.mode === "time" &&
                    String(obj.mode2) === "60" &&
                    userdata.discordId !== null &&
                    userdata.discordId !== undefined
                  ) {
                    if (verified !== false) {
                      console.log(
                        `sending command to the bot to update the role for user ${request.uid} with wpm ${obj.wpm}`
                      );
                      updateDiscordRole(
                        userdata.discordId,
                        Math.round(obj.wpm)
                      );
                    }
                  }
                  returnobj.resultCode = 2;
                } else {
                  let logobj = request.obj;
                  logobj.keySpacing = "removed";
                  logobj.keyDuration = "removed";
                  console.log(
                    `saved result for ${request.uid} - ${JSON.stringify(
                      logobj
                    )}`
                  );
                  returnobj.resultCode = 1;
                }
                response.status(200).send({ data: returnobj });
                return;
              })
              .catch((e) => {
                console.error(
                  `error saving result when checking for PB / checking leaderboards for ${request.uid} - ${e.message}`
                );
                response
                  .status(200)
                  .send({ data: { resultCode: -999, message: e.message } });
                return;
              });
          })
          .catch((e) => {
            console.error(
              `error saving result when adding result to the db for ${request.uid} - ${e.message}`
            );
            response
              .status(200)
              .send({ data: { resultCode: -999, message: e.message } });
            return;
          });
      })
      .catch((e) => {
        console.error(
          `error saving result when getting user data for ${request.uid} - ${e.message}`
        );
        response
          .status(200)
          .send({ data: { resultCode: -999, message: e.message } });
        return;
      });
  } catch (e) {
    console.error(
      `error saving result for ${request.uid} - ${JSON.stringify(
        request.obj
      )} - ${e}`
    );
    response
      .status(200)
      .send({ data: { resultCode: -999, message: e.message } });
    return;
  }
});

function updateDiscordRole(discordId, wpm) {
  db.collection("bot-commands").add({
    command: "updateRole",
    arguments: [discordId, wpm],
    executed: false,
    requestTimestamp: Date.now(),
  });
}

function isTagValid(name) {
  if (name === null || name === undefined || name === "") return false;
  if (name.length > 16) return false;
  return /^[0-9a-zA-Z_.-]+$/.test(name);
}

exports.addTag = functions.https.onCall((request, response) => {
  try {
    if (!isTagValid(request.name)) {
      return { resultCode: -1 };
    } else {
      return db
        .collection(`users/${request.uid}/tags`)
        .add({
          name: request.name,
        })
        .then((e) => {
          console.log(`user ${request.uid} created a tag: ${request.name}`);
          return {
            resultCode: 1,
            id: e.id,
          };
        })
        .catch((e) => {
          console.error(
            `error while creating tag for user ${request.uid}: ${e.message}`
          );
          return { resultCode: -999 };
        });
    }
  } catch (e) {
    console.error(`error adding tag for ${request.uid} - ${e}`);
    return { resultCode: -999 };
  }
});

exports.editTag = functions.https.onCall((request, response) => {
  try {
    if (!isTagValid(request.name)) {
      return { resultCode: -1 };
    } else {
      return db
        .collection(`users/${request.uid}/tags`)
        .doc(request.tagid)
        .update({
          name: request.name,
        })
        .then((e) => {
          console.log(`user ${request.uid} updated a tag: ${request.name}`);
          return {
            resultCode: 1,
          };
        })
        .catch((e) => {
          console.error(
            `error while updating tag for user ${request.uid}: ${e.message}`
          );
          return { resultCode: -999 };
        });
    }
  } catch (e) {
    console.error(`error updating tag for ${request.uid} - ${e}`);
    return { resultCode: -999 };
  }
});

exports.removeTag = functions.https.onCall((request, response) => {
  try {
    return db
      .collection(`users/${request.uid}/tags`)
      .doc(request.tagid)
      .delete()
      .then((e) => {
        console.log(`user ${request.uid} deleted a tag`);
        return {
          resultCode: 1,
        };
      })
      .catch((e) => {
        console.error(
          `error deleting tag for user ${request.uid}: ${e.message}`
        );
        return { resultCode: -999 };
      });
  } catch (e) {
    console.error(`error deleting tag for ${request.uid} - ${e}`);
    return { resultCode: -999 };
  }
});

exports.updateResultTags = functions.https.onCall((request, response) => {
  try {
    let validTags = true;
    request.tags.forEach((tag) => {
      if (!/^[0-9a-zA-Z]+$/.test(tag)) validTags = false;
    });
    if (validTags) {
      return db
        .collection(`users/${request.uid}/results`)
        .doc(request.resultid)
        .update({
          tags: request.tags,
        })
        .then((e) => {
          console.log(
            `user ${request.uid} updated tags for result ${request.resultid}`
          );
          return {
            resultCode: 1,
          };
        })
        .catch((e) => {
          console.error(
            `error while updating tags for result by user ${request.uid}: ${e.message}`
          );
          return { resultCode: -999 };
        });
    } else {
      console.error(`invalid tags for user ${request.uid}: ${request.tags}`);
      return { resultCode: -1 };
    }
  } catch (e) {
    console.error(`error updating tags by ${request.uid} - ${e}`);
    return { resultCode: -999 };
  }
});

function isConfigKeyValid(name) {
  if (name === null || name === undefined || name === "") return false;
  if (name.length > 30) return false;
  return /^[0-9a-zA-Z_.\-#]+$/.test(name);
}

exports.saveConfig = functions.https.onCall((request, response) => {
  try {
    if (request.uid === undefined || request.obj === undefined) {
      console.error(`error saving config for ${request.uid} - missing input`);
      return {
        returnCode: -1,
        message: "Missing input",
      };
    }

    let obj = request.obj;
    let errorMessage = "";
    let err = false;
    Object.keys(obj).forEach((key) => {
      if (err) return;
      if (!isConfigKeyValid(key)) {
        err = true;
        console.error(`${key} failed regex check`);
        errorMessage = `${key} failed regex check`;
      }
      if (err) return;
      if (key === "resultFilters") return;
      let val = obj[key];
      if (Array.isArray(val)) {
        val.forEach((valarr) => {
          if (!isConfigKeyValid(valarr)) {
            err = true;
            console.error(`${key}: ${valarr} failed regex check`);
            errorMessage = `${key}: ${valarr} failed regex check`;
          }
        });
      } else {
        if (!isConfigKeyValid(val)) {
          err = true;
          console.error(`${key}: ${val} failed regex check`);
          errorMessage = `${key}: ${val} failed regex check`;
        }
      }
    });
    if (err) {
      console.error(
        `error saving config for ${request.uid} - bad input - ${JSON.stringify(
          request.obj
        )}`
      );
      return {
        returnCode: -1,
        message: "Bad input. " + errorMessage,
      };
    }

    return db
      .collection(`users`)
      .doc(request.uid)
      .set(
        {
          config: obj,
        },
        { merge: true }
      )
      .then((e) => {
        return {
          returnCode: 1,
          message: "Saved",
        };
      })
      .catch((e) => {
        console.error(
          `error saving config to DB for ${request.uid} - ${e.message}`
        );
        return {
          returnCode: -1,
          message: e.message,
        };
      });
  } catch (e) {
    console.error(`error saving config for ${request.uid} - ${e}`);
    return {
      resultCode: -999,
      message: e,
    };
  }
});

function generate(n) {
  var add = 1,
    max = 12 - add;

  if (n > max) {
    return generate(max) + generate(n - max);
  }

  max = Math.pow(10, n + add);
  var min = max / 10; // Math.pow(10, n) basically
  var number = Math.floor(Math.random() * (max - min + 1)) + min;

  return ("" + number).substring(add);
}

class Leaderboard {
  constructor(size, mode, mode2, type, starting) {
    this.size = size;
    this.board = [];
    this.mode = mode;
    this.mode2 = parseInt(mode2);
    this.type = type;
    if (starting !== undefined && starting !== null) {
      starting.forEach((entry) => {
        if (
          entry.mode == this.mode &&
          parseInt(entry.mode2) === parseInt(this.mode2)
        ) {
          let hid = entry.hidden === undefined ? false : entry.hidden;
          this.board.push({
            uid: entry.uid,
            name: entry.name,
            wpm: parseFloat(entry.wpm),
            raw: parseFloat(entry.raw),
            acc: parseFloat(entry.acc),
            mode: entry.mode,
            mode2: parseInt(entry.mode2),
            timestamp: entry.timestamp,
            hidden: hid,
          });
        }
      });
    }
    this.sortBoard();
    this.clipBoard();
  }
  sortBoard() {
    this.board.sort((a, b) => {
      if (a.wpm === b.wpm) {
        if (a.acc === b.acc) {
          return a.timestamp - b.timestamp;
        } else {
          return b.acc - a.acc;
        }
      } else {
        return b.wpm - a.wpm;
      }
    });
  }
  clipBoard() {
    let boardLength = this.board.length;
    if (boardLength > this.size) {
      while (this.board.length !== this.size) {
        this.board.pop();
      }
    }
  }
  logBoard() {
    console.log(this.board);
  }
  removeDuplicates(insertedAt, uid) {
    //return true if a better result is found
    let found = false;
    // let ret;
    let foundAt = null;
    if (this.board !== undefined) {
      this.board.forEach((entry, index) => {
        if (entry.uid === uid) {
          if (found) {
            this.board.splice(index, 1);
            // if (index > insertedAt) {
            //   //removed old result
            //   ret = false;
            // } else {
            //   ret = true;
            // }
          } else {
            found = true;
            foundAt = index;
          }
        }
      });
    }
    // console.log(ret);
    // return ret;
    return foundAt;
  }
  insert(a) {
    let insertedAt = -1;
    if (a.mode == this.mode && parseInt(a.mode2) === parseInt(this.mode2)) {
      this.board.forEach((b, index) => {
        if (insertedAt !== -1) return;
        if (a.wpm === b.wpm) {
          if (a.acc === b.acc) {
            if (a.timestamp < b.timestamp) {
              this.board.splice(index, 0, {
                uid: a.uid,
                name: a.name,
                wpm: parseFloat(a.wpm),
                raw: parseFloat(a.rawWpm),
                acc: parseFloat(a.acc),
                mode: a.mode,
                mode2: parseInt(a.mode2),
                timestamp: a.timestamp,
                hidden: a.hidden === undefined ? false : a.hidden,
              });
              insertedAt = index;
            }
          } else {
            if (a.acc > b.acc) {
              this.board.splice(index, 0, {
                uid: a.uid,
                name: a.name,
                wpm: parseFloat(a.wpm),
                raw: parseFloat(a.rawWpm),
                acc: parseFloat(a.acc),
                mode: a.mode,
                mode2: parseInt(a.mode2),
                timestamp: a.timestamp,
                hidden: a.hidden === undefined ? false : a.hidden,
              });
              insertedAt = index;
            }
          }
        } else {
          if (a.wpm > b.wpm) {
            this.board.splice(index, 0, {
              uid: a.uid,
              name: a.name,
              wpm: parseFloat(a.wpm),
              raw: parseFloat(a.rawWpm),
              acc: parseFloat(a.acc),
              mode: a.mode,
              mode2: parseInt(a.mode2),
              timestamp: a.timestamp,
              hidden: a.hidden === undefined ? false : a.hidden,
            });
            insertedAt = index;
          }
        }
      });
      if (this.board.length < this.size && insertedAt === -1) {
        this.board.push({
          uid: a.uid,
          name: a.name,
          wpm: parseFloat(a.wpm),
          raw: parseFloat(a.rawWpm),
          acc: parseFloat(a.acc),
          mode: a.mode,
          mode2: parseInt(a.mode2),
          timestamp: a.timestamp,
          hidden: a.hidden === undefined ? false : a.hidden,
        });
        insertedAt = this.board.length - 1;
      }
      // console.log("before duplicate remove");
      // console.log(this.board);
      let newBest = false;
      let foundAt = null;
      if (insertedAt >= 0) {
        // if (this.removeDuplicates(insertedAt, a.uid)) {
        //   insertedAt = -2;
        // }
        foundAt = this.removeDuplicates(insertedAt, a.uid);

        if (foundAt >= insertedAt) {
          //new better result
          newBest = true;
        }
      }
      // console.log(this.board);
      this.clipBoard();
      return {
        insertedAt: insertedAt,
        newBest: newBest,
        foundAt: foundAt,
      };
    } else {
      return {
        insertedAt: -999,
      };
    }
  }
}

exports.generatePairingCode = functions
  .runWith({
    timeoutSeconds: 100,
    memory: "2GB",
  })
  .https.onRequest((request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      // Send response to OPTIONS requests
      response.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      response.set(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type"
      );
      response.set("Access-Control-Max-Age", "3600");
      response.status(204).send("");
      return;
    }
    request = request.body.data;
    try {
      if (request === null) {
        console.error(
          `error while trying to generate discord pairing code - no input`
        );
        response.status(200).send({ data: { status: -999 } });
        return;
      }

      return db
        .collection("users")
        .doc(request.uid)
        .get()
        .then((userDoc) => {
          userDocData = userDoc.data();
          if (userDocData.discordPairingCode !== undefined) {
            console.log(
              `user ${request.uid} already has code ${userDocData.discordPairingCode}`
            );
            return {
              status: 2,
              pairingCode: userDocData.discordPairingCode,
            };
          } else {
            return db
              .collection("users")
              .get()
              .then((res) => {
                let existingCodes = [];

                res.docs.forEach((doc) => {
                  let docData = doc.data();
                  if (docData.discordPairingCode !== undefined) {
                    existingCodes.push(docData.discordPairingCode);
                  }
                });

                // console.log(`existing codes ${JSON.stringify(existingCodes)}`);

                let randomCode = generate(9);

                while (existingCodes.includes(randomCode)) {
                  randomCode = generate(9);
                }

                return db
                  .collection("users")
                  .doc(request.uid)
                  .update(
                    {
                      discordPairingCode: randomCode,
                    },
                    { merge: true }
                  )
                  .then((res) => {
                    console.log(
                      `generated ${randomCode} for user ${request.uid}`
                    );
                    response.status(200).send({
                      data: {
                        status: 1,
                        pairingCode: randomCode,
                      },
                    });
                    return;
                  })
                  .catch((e) => {
                    console.error(
                      `error while trying to set discord pairing code ${randomCode} for user ${request.uid} - ${e}`
                    );
                    response.status(200).send({
                      data: {
                        status: -999,
                      },
                    });
                    return;
                  });
              });
          }
        });
    } catch (e) {
      console.error(
        `error while trying to generate discord pairing code for user ${request.uid} - ${e}`
      );
      response.status(200).send({
        data: {
          status: -999,
        },
      });
      return;
    }
  });

async function checkLeaderboards(
  resultObj,
  type,
  banned,
  name,
  verified,
  emailVerified
) {
  //lb disable
  // return {
  //   insertedAt: null,
  // };
  //
  try {
    if (emailVerified === false)
      return {
        insertedAt: null,
        needsToVerifyEmail: true,
      };
    if (!name)
      return {
        insertedAt: null,
        noName: true,
      };
    if (banned)
      return {
        insertedAt: null,
        banned: true,
      };
    if (verified === false)
      return {
        insertedAt: null,
        needsToVerify: true,
      };

    if (
      resultObj.mode === "time" &&
      ["15", "60"].includes(String(resultObj.mode2)) &&
      resultObj.language === "english"
    ) {
      return await db.runTransaction(async (t) => {
        const lbdoc = await t.get(
          db
            .collection("leaderboards")
            .where("mode", "==", String(resultObj.mode))
            .where("mode2", "==", String(resultObj.mode2))
            .where("type", "==", type)
        );
        let lbData;
        let docid = `${String(resultObj.mode)}_${String(
          resultObj.mode2
        )}_${type}`;
        if (lbdoc.docs.length === 0) {
          console.log(
            `no ${resultObj.mode} ${resultObj.mode2} ${type} leaderboard found - creating`
          );
          let toAdd = {
            size: 20,
            mode: String(resultObj.mode),
            mode2: String(resultObj.mode2),
            type: type,
          };
          await t.set(
            db
              .collection("leaderboards")
              .doc(
                `${String(resultObj.mode)}_${String(resultObj.mode2)}_${type}`
              ),
            toAdd
          );
          lbData = toAdd;
        } else {
          lbData = lbdoc.docs[0].data();
        }
        let boardInfo = lbData;
        let boardData = lbData.board;
        let lb = new Leaderboard(
          boardInfo.size,
          resultObj.mode,
          resultObj.mode2,
          boardInfo.type,
          boardData
        );
        let insertResult = lb.insert(resultObj);

        if (insertResult.insertedAt >= 0) {
          //update the database here
          console.log(
            `leaderboard changed ${resultObj.mode} ${
              resultObj.mode2
            } ${type} - ${JSON.stringify(lb.board)}`
          );
          await t.update(db.collection("leaderboards").doc(docid), {
            size: lb.size,
            type: lb.type,
            board: lb.board,
          });
        }

        return {
          insertedAt: insertResult,
        };
      });
    } else {
      return {
        insertedAt: null,
      };
    }
  } catch (e) {
    console.error(
      `error while checking leaderboards - ${e} - ${type} ${resultObj}`
    );
    return {
      insertedAt: null,
    };
  }
}

exports.getLeaderboard = functions.https.onCall((request, response) => {
  return db
    .collection("leaderboards")
    .where("mode", "==", String(request.mode))
    .where("mode2", "==", String(request.mode2))
    .where("type", "==", String(request.type))
    .get()
    .then(async (data) => {
      // console.log("got data");
      if (data.docs.length === 0) return null;
      let lbdata = data.docs[0].data();
      if (lbdata.board !== undefined) {
        // console.log("replacing users");

        // for (let i = 0; i < lbdata.board.length; i++) {
        //   await db
        //     .collection("users")
        //     .doc(lbdata.board[i].uid)
        //     .get()
        //     .then((doc) => {
        //       if (
        //         lbdata.board[i].uid !== null &&
        //         lbdata.board[i].uid === request.uid
        //       ) {
        //         lbdata.board[i].currentUser = true;
        //       }
        //       lbdata.board[i].name = doc.data().name;
        //       lbdata.board[i].uid = null;
        //     });
        // }

        lbdata.board.forEach((boardentry) => {
          if (boardentry.uid !== null && boardentry.uid === request.uid) {
            boardentry.currentUser = true;
          }
          boardentry.uid = null;
        });

        // console.log(lbdata);
        if (request.type === "daily") {
          let resetTime = new Date(Date.now());
          resetTime.setHours(0, 0, 0, 0);
          resetTime.setDate(resetTime.getUTCDate() + 1);
          resetTime = resetTime.valueOf();
          lbdata.resetTime = resetTime;
        }

        return lbdata;
      } else {
        if (
          lbdata.board === undefined ||
          lbdata.board === [] ||
          lbdata.board.length === 0
        ) {
          return lbdata;
        } else {
          return [];
        }
      }
    });
});

exports.scheduledFunctionCrontab = functions.pubsub
  .schedule("00 00 * * *")
  .timeZone("Africa/Abidjan")
  .onRun((context) => {
    try {
      console.log("moving daily leaderboards to history");
      db.collection("leaderboards")
        .where("type", "==", "daily")
        .get()
        .then(async (res) => {
          for (let i = 0; i < res.docs.length; i++) {
            let doc = res.docs[i];

            let lbdata = doc.data();

            let winnerUid = lbdata.board[0].uid;
            await db
              .collection("users")
              .doc(winnerUid)
              .get()
              .then(async (userDoc) => {
                let userData = userDoc.data();
                let lbwins = userData.dailyLbWins;

                let lbname = lbdata.mode + lbdata.mode2;

                if (lbwins === undefined) {
                  //first win ever
                  lbwins = {
                    [lbname]: 1,
                  };
                } else {
                  //object already exists
                  if (lbwins[lbname] === undefined) {
                    lbwins[lbname] = 1;
                  } else {
                    lbwins[lbname] = lbwins[lbname] + 1;
                  }
                }
                await db.collection("users").doc(winnerUid).update({
                  dailyLbWins: lbwins,
                });
              });

            announceDailyLbResult(lbdata);
            t = new Date();
            db.collection("leaderboards_history")
              .doc(
                `${t.getUTCDate()}_${t.getUTCMonth()}_${t.getUTCFullYear()}_${
                  lbdata.mode
                }_${lbdata.mode2}`
              )
              .set(lbdata);
            db.collection("leaderboards").doc(doc.id).set(
              {
                board: [],
              },
              { merge: true }
            );
          }
        });
      return null;
    } catch (e) {
      console.error(`error while moving daily leaderboards to history - ${e}`);
    }
  });

async function announceLbUpdate(discordId, pos, lb, wpm) {
  db.collection("bot-commands").add({
    command: "sayLbUpdate",
    arguments: [discordId, pos, lb, wpm],
    executed: false,
    requestTimestamp: Date.now(),
  });
}

async function announceDailyLbResult(lbdata) {
  db.collection("bot-commands").add({
    command: "announceDailyLbResult",
    arguments: [lbdata],
    executed: false,
    requestTimestamp: Date.now(),
  });
}
