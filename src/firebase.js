import firebase from "firebase/app";
import "firebase/auth";
import "firebase/firestore";
import { firebaseConfig } from "./secrets";
import { ref, onUnmounted, computed } from "vue";

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const firestore = firebase.firestore();

const stations = ["registration", "screening", "vitals", "vaccination", "post"];

/** Contains the user ids of the auth users and their permissions
 *
 * Warning: No security whatsoever.
 */
const permissions = () => {
  return new Promise((resolve, reject) => {
    try {
      let userPermissions = {};
      firestore
        .collection("permissions")
        .get()
        .then((snapshot) => {
          snapshot.docs.reduce((mapVal, doc) => {
            // console.log("IN LOOP: ", mapVal, doc.data().ids);
            mapVal[doc.id] = doc.data().ids;
            return mapVal;
          }, userPermissions);
          resolve(userPermissions);
        });
    } catch (err) {
      reject(err);
    }
  });
};

/** Hooks for router */
export function useAuthServer() {
  const user = ref(null);
  auth.onAuthStateChanged((_user) => (user.value = _user));
  const isLogin = computed(() => user.value !== null);

  return { isLogin, user, permissions };
}

/** Hooks for firebase auth in client */
export function useAuth() {
  const user = ref(null);
  const unsubscribe = auth.onAuthStateChanged((_user) => (user.value = _user));
  onUnmounted(unsubscribe);
  const isLogin = computed(() => user.value !== null);

  /**
   * Signs in user
   * @param String email
   * @param String password
   */
  const signInWithForm = async (email, password) => {
    return new Promise((resolve, reject) => {
      auth
        .signInWithEmailAndPassword(email, password)
        .then(() => {
          resolve("Logged in successfully!");
        })
        .catch((err) => reject(err));
    });
  };

  /** Signs out user */
  const signOut = () => {
    return new Promise((resolve, reject) => {
      auth
        .signOut()
        .then(resolve("Signed out!"))
        .catch((err) => reject(err));
    });
  };

  return { user, isLogin, signInWithForm, signOut };
}

/*** Collection of all queue numbers */
const queueNumCollection = firestore.collection("queue");

/*** Collection of queue numbers in ascending order */
const queueNumAscending = queueNumCollection.orderBy("queueTime", "asc");

/** Counter for the queue */
const queueCounterRef = firestore.collection("counter").doc("queueNum");

/*** Reference to Station Details Collection in Firestore */
const stationDetailsRef = firestore.collection("stationDetails");

const increment = firebase.firestore.FieldValue.increment(1);
const decrement = firebase.firestore.FieldValue.increment(-1);

export function useQueue() {
  /*** Gets the queue items as a VueJS ref */
  const queueItems = ref([]);

  // Watch the queue items
  // Also, hook for cleanup when component is unmounted
  const unsubscribe = queueNumAscending.onSnapshot((snapshot) => {
    queueItems.value = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  });

  onUnmounted(unsubscribe);

  /**
   * Issue Queue No
   * Uses transactions to get the current queue no.
   */
  const issueQueueNum = async () => {
    // Return value to indicate the number to be issued
    var newQueueNo;

    // Transaction start
    await firestore.runTransaction((transaction) => {
      // Reads the queue counter in the counter collection
      return transaction.get(queueCounterRef).then((counterRef) => {
        if (!counterRef) throw "Document does not exist";

        // Get the next count
        newQueueNo = counterRef.data().count + 1;

        // Create a new document in the queue number collection
        var queueNumRef = queueNumCollection.doc();

        // Increment the counter
        transaction.update(queueCounterRef, {
          count: newQueueNo,
        });

        // Save the new queue no
        transaction.set(queueNumRef, {
          num: newQueueNo,
          queueTime: firebase.firestore.FieldValue.serverTimestamp(),
          stage: 0,
          timestamps: {
            issue: firebase.firestore.FieldValue.serverTimestamp(),
            registration: null,
            screening: null,
            vitals: null,
            vaccination: null,
            observation: null,
            exit: null,
          },
          // issueTime: firebase.firestore.FieldValue.serverTimestamp(),
          // registrationTime: null,
          // screeningTime: null,
          // vitalsTime: null,
          // vaccinationTime: null,
          // postTime: null,
          // exitTime: null,
        });
      });
    });

    return newQueueNo;
  };

  // Function Definition for Station Control
  const callForNextNum = async (stage) => {
    try {
      const station = stations[stage / 2];

      // Authenticate the user
      if (!auth.currentUser) throw "You are not authenticated.";

      // Check to see if user is authenticated
      // if (
      //   auth.currentUser === null ||
      //   auth.currentUser === undefined ||
      //   !(
      //     userUids[station].includes(auth.currentUser.uid) ||
      //     adminUids.includes(auth.currentUser.uid)
      //   )
      // )
      //   throw "You are not authorized for this station.";

      var nextQueueNum;

      await firestore.runTransaction(async (transaction) => {
        // Get the latest num with the correct stage
        let query = await queueNumAscending
          .where("stage", "==", stage)
          .limit(1)
          .get();

        // If query is empty AKA No one w/ the stage is found,
        // Throw an error
        if (query.empty) throw "No one is in the waiting list.";

        const doc = query.docs[0].ref;

        // console.log("before transaction", query, doc);
        // Finally do the transaction.
        return transaction.get(doc).then((snapshot) => {
          // More error to throw
          if (!snapshot) throw "Document does not exist";

          // Get the next queue num object
          nextQueueNum = { id: query.docs[0].id, ...snapshot.data() };

          // Increment the stage
          // const nextStage = snapshot.data().stage + 1;

          // Update the timestamps
          const newData = snapshot.data();
          newData.timestamps[
            station
          ] = firebase.firestore.FieldValue.serverTimestamp();
          newData.stage = newData.stage + 1;

          // Update the table
          transaction.update(doc, newData);
          transaction.update(stationDetailsRef.doc(auth.currentUser.uid), {
            currentQueueId: { id: snapshot.id, ...newData },
          });
        });
      });
    } catch (err) {
      // Return the error
      console.error(err);
      return Promise.reject(err);
    }

    return nextQueueNum;
  };

  const finishCurrentNum = async (queueId, station = "registration") => {
    try {
      // Authenticate the user
      if (!auth.currentUser) throw "You are not authenticated.";

      // Check if queue Id is invalid
      if (queueId === null || queueId === undefined)
        throw "You have returned an invalid queue number";

      // Update the queue item
      await queueNumCollection.doc(queueId).update({
        stage: increment,
        [`timestamps.${station}`]: firebase.firestore.FieldValue.serverTimestamp(),
      });

      // Update the station details
      await stationDetailsRef.doc(auth.currentUser.uid).update({
        currentQueueId: null,
      });

      return true;
    } catch (err) {
      return Promise.reject(err);
    }
  };

  /**
   * Displays the details of each station and their assigned queue numbers
   * @param String station - name of the station category
   * @returns
   */
  const stationDisplayQueueNums = (station) => {
    const displayQueueNums = ref([]);

    // Watch the queue items
    // Also, hook for cleanup when component is unmounted
    const displayUnsubscribe = stationDetailsRef
      .where("stationType", "==", station)
      .orderBy("stationNum", "asc")
      .onSnapshot((snapshot) => {
        const data = snapshot.docs.map((doc) => {
          let curr;
          if (doc.data().currentQueueId) curr = doc.data().currentQueueId.num;
          else curr = null;
          return {
            station: `Station ${doc.data().stationNum}`,
            currentNum: curr,
            ...doc.data(),
          };
        });
        const changes = snapshot
          .docChanges()
          .map((change) => `Station ${change.doc.data().stationNum}`);
        displayQueueNums.value = { data, changes };
      });

    onUnmounted(displayUnsubscribe);

    return displayQueueNums;
  };

  /** Get queue number by its id */
  const getQueueNumberById = async (id) => {
    if (id == "" || id == null) return;
    let queueNum;

    queueNum = await queueNumCollection.doc(id).get();

    if (!queueNum.exists) return false;

    return { id: id, ...queueNum.data() };
  };

  /** Get the queue number assigned to the authUser's station */
  const getQueueNumberByAuth = async (uid) => {
    try {
      const queueNum = await (await stationDetailsRef.doc(uid).get()).data()
        .currentQueueId;

      return Promise.resolve(queueNum);
    } catch (err) {
      return Promise.reject(err);
    }
  };

  /**
   * Sends back the number to the back of the queue
   * @param String id - ID of the queue number
   */
  const unqueueNum = (id) => {
    return new Promise((resolve, reject) => {
      if (!id) reject("ID is not valid.");
      if (!auth.currentUser) reject("You are not authenticated.");

      queueNumCollection
        .doc(id)
        .get()
        .then((docRef) => {
          if (!docRef.exists) reject("Could not find queue number.");
          stationDetailsRef.doc(auth.currentUser.uid).update({
            currentQueueId: null,
          });
          docRef.ref
            .update({
              queueTime: firebase.firestore.FieldValue.serverTimestamp(),
              stage: decrement,
            })
            .then(() => {
              resolve("Queue number has been set back");
            });
        })
        .catch((err) => reject(err));
    });
  };

  const rejectNum = (id) => {
    return new Promise((resolve, reject) => {
      if (!id) reject("ID is not valid.");
      if (!auth.currentUser) reject("You are not authenticated.");

      queueNumCollection
        .doc(id)
        .get()
        .then((docRef) => {
          if (!docRef.exists)
            if (!docRef.exists) reject("Could not find queue number.");
          stationDetailsRef.doc(auth.currentUser.uid).update({
            currentQueueId: null,
          });
          docRef.ref
            .update({
              stage: -1,
            })
            .then(() => {
              resolve("Queue number has been rejected");
            });
        });
    });
  };

  return {
    queueItems,
    issueQueueNum,
    callForNextNum,
    finishCurrentNum,
    stationDisplayQueueNums,
    getQueueNumberById,
    unqueueNum,
    rejectNum,
    getQueueNumberByAuth,
  };
}

/** Hook for monitoring pages */
export function useMonitoring(stage) {
  const station = stations[stage / 2];
  const prevStation = stations[stage / 2 - 1];

  /** Get a list of queue numbers in the current station
   *  and the stations above it. This is so we can calculate
   *  wait times at the same time to save on reads
   */
  const getStationQueueList = () => {
    const queueList = ref(null);
    const waitTime = ref(null);

    queueNumCollection.where("stage", ">=", stage).onSnapshot((snapshot) => {
      const numCollection = snapshot.docs.map((doc) => {
        return {
          id: doc.id,
          ...doc.data(),
        };
      });
      queueList.value = numCollection.filter(
        (queueItem) => queueItem.stage == stage
      );
      waitTime.value =
        numCollection
          .filter((queueItem) => queueItem.stage > stage)
          .map((queueItem) => {
            const currentStationTimestamp = queueItem.timestamps[station];
            const prevStationTimestamp = queueItem.timestamps[prevStation];
            return (
              currentStationTimestamp.seconds - prevStationTimestamp.seconds
            );
          })
          .reduce((a, b) => a + b, 0) / numCollection.length;
    });

    return { queueList, waitTime };
  };

  const advanceQueueNumber = (id) => {
    return new Promise((resolve, reject) => {
      queueNumCollection
        .doc(id)
        .get()
        .then((docRef) => {
          if (!docRef.exists) reject("Number does not exist.");

          const newTimestamp = docRef.data().timestamps;
          newTimestamp[
            station
          ] = firebase.firestore.FieldValue.serverTimestamp();

          docRef.ref
            .update({
              stage: firebase.firestore.FieldValue.increment(2), // Increments by 2 to follow the stage flow
              timestamps: newTimestamp,
            })
            .then(() => {
              resolve("Update successfull!");
            })
            .catch((err) => reject(err));
        })
        .catch((err) => reject(err));
    });
  };

  const rejectQueueNumber = (id) => {
    return new Promise((resolve, reject) => {
      queueNumCollection
        .doc(id)
        .get()
        .then((docRef) => {
          if (!docRef.exists) reject("Number does not exist.");

          docRef.ref
            .update({
              stage: -1,
            })
            .then(() => {
              resolve("Rejection successfull!");
            })
            .catch((err) => reject(err));
        })
        .catch((err) => reject(err));
    });
  };

  return {
    getStationQueueList,
    advanceQueueNumber,
    rejectQueueNumber,
  };
}

/** Hooks for the Admin page. Requires the admin user */
export function useAdmin() {
  /**
   * Seed the entire firestore database
   *
   * Creates the queue counter, the station accounts, and the station details
   */
  const seedUsers = async () => {
    try {
      const batch = firestore.batch();

      batch.set(queueCounterRef, {
        counter: 0,
      });

      for (const station of stations) {
        let uids = [];
        for (let x = 1; x <= 10; x++) {
          console.log(`Creating user ${x} of station ${station}`);
          const userCred = await auth.createUserWithEmailAndPassword(
            `station-${x}@${station}.station`,
            `${station}!stn${x}`
          );
          uids.push(userCred.user.uid);
          batch.set(
            firestore.collection("stationDetails").doc(userCred.user.uid),
            {
              currentQueueId: null,
              stationNum: x,
              stationType: station,
            }
          );
        }
        batch.set(firestore.collection("permissions").doc(station), {
          ids: uids,
        });
      }
      await batch.commit();
      return Promise.resolve("Done seeding!");
    } catch (err) {
      return Promise.reject(err);
    }
  };

  /**
   * Resets the queue.
   *
   * Station Details collection will have their current queue numbers set to null
   *
   * The entire queue number collection will be deleted
   *
   * Resets counter to 0
   */
  const resetQueue = async () => {
    try {
      const writeBatch = firestore.batch();
      let deleteBatch = firestore.batch();
      const stationDetailsData = await firestore
        .collection("stationDetails")
        .get();
      const queueItemsData = await queueNumCollection.get();

      writeBatch.set(queueCounterRef, {
        count: 0,
      });

      stationDetailsData.docs.forEach((docRef) => {
        writeBatch.update(docRef.ref, {
          currentQueueId: null,
        });
      });

      let i = 0;

      for (const doc of queueItemsData.docs) {
        deleteBatch.delete(doc.ref);
        i++;
        if (i > 400) {
          i = 0;
          await deleteBatch.commit();
          deleteBatch = firestore.batch();
        }
      }

      await deleteBatch.commit();
      await writeBatch.commit();

      return Promise.resolve("Done resetting the queue!");
    } catch (err) {
      return Promise.reject(err);
    }
  };

  const runTestQueries = () => {
    queueNumCollection
      .orderBy("queueTime", "asc")
      .get()
      .then((snapshot) => {
        console.log("Issue Num OK!", snapshot);
      });
    stationDetailsRef
      .where("stationType", "==", "registration")
      .orderBy("stationNum", "asc")
      .get()
      .then((snapshot) => {
        console.log("Display OK!", snapshot);
      });
    queueNumAscending
      .where("stage", "==", 0)
      .where("rejected", "==", null)
      .limit(1)
      .get()
      .then((snapshot) => {
        console.log("Station Control OK!", snapshot);
      });
  };

  return {
    seedUsers,
    resetQueue,
    runTestQueries,
  };
}
