import { SetForm, TaskForm } from '../../taskform'
import { Person, Place } from '../../types'
import { PeoplePicker } from '../PeoplePicker'
import { PlacePicker } from '../PlacePicker'

interface Props {
  form: Pick<TaskForm, 'peopleIds' | 'placeId'>
  set: SetForm
  people: Person[]
  places: Place[]
  onSavePlace?(p: Place): void
  /** Save someone typed here who isn't in People yet. Without it the picker only finds people. */
  onSavePerson?(p: Person): void
}

/** Who the task involves (anyone new can be added by name), and where it happens. */
export function PeoplePlace({ form, set, people, places, onSavePlace, onSavePerson }: Props) {
  return (
    <>
      <PeoplePicker
        peopleIds={form.peopleIds}
        onChange={update => set(f => ({ peopleIds: update(f.peopleIds) }))}
        people={people}
        onSavePerson={onSavePerson}
        hint="marking this done counts as seeing them"
        noun="task"
      />

      <PlacePicker
        placeId={form.placeId}
        onChange={placeId => set({ placeId })}
        places={places}
        onSavePlace={onSavePlace}
        label="Where"
        hint="marking this done counts as an outing there"
      />
    </>
  )
}
